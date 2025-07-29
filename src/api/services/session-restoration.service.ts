import { Logger } from '@config/logger.config';
import { WAMonitoringService } from '@api/services/monitor.service';
import { CacheService } from '@api/services/cache.service';
import { PrismaRepository } from '@api/repository/repository.service';
import { InstanceDto } from '@api/dto/instance.dto';
import { Database, CacheConf, ConfigService } from '@config/env.config';
import { Integration } from '@api/types/wa.types';

export class SessionRestorationService {
  private readonly logger = new Logger('SessionRestorationService');
  private readonly db: Partial<Database> = {};
  private readonly redis: Partial<CacheConf> = {};

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly cache: CacheService,
    private readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
  ) {
    Object.assign(this.db, configService.get<Database>('DATABASE'));
    Object.assign(this.redis, configService.get<CacheConf>('CACHE'));
  }

  /**
   * Enhanced session restoration with fallback mechanisms
   */
  public async restoreAllSessions(): Promise<void> {
    this.logger.info('Starting enhanced session restoration process');

    try {
      const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
      let restoredCount = 0;

      // Strategy 1: Restore from Redis cache if enabled
      if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
        restoredCount += await this.restoreFromRedisCache();
      }

      // Strategy 2: Restore from database if enabled
      if (this.db.SAVE_DATA.INSTANCE) {
        restoredCount += await this.restoreFromDatabase(clientName);
      }

      // Strategy 3: Restore from provider files if enabled (fallback)
      if (restoredCount === 0) {
        restoredCount += await this.restoreFromProviderFiles();
      }

      this.logger.info(`Session restoration completed. Restored ${restoredCount} instances`);

      // Start connection verification for all restored instances
      await this.verifyRestoredConnections();

    } catch (error) {
      this.logger.error(`Session restoration failed: ${error?.toString()}`);
      throw error;
    }
  }

  private async restoreFromRedisCache(): Promise<number> {
    try {
      this.logger.info('Attempting to restore sessions from Redis cache');
      
      // First, attempt to clean up any corrupted keys
      if (this.cache?.cleanupCorruptedKeys) {
        const cleanedCount = await this.cache.cleanupCorruptedKeys();
        if (cleanedCount > 0) {
          this.logger.info(`Cleaned up ${cleanedCount} corrupted Redis keys before restoration`);
        }
      }
      
      // Use the correct key pattern - the cache service automatically builds the full key
      const keys = await this.cache.keys('');
      if (!keys || keys.length === 0) {
        this.logger.info('No instance keys found in Redis cache');
        return 0;
      }

      this.logger.info(`Found ${keys.length} keys in Redis cache, filtering for instances`);

      let restored = 0;
      for (const fullKey of keys) {
        try {
          // Extract the instance key from the full Redis key
          // Format: evolution_cache:instance:instanceId
          const keyParts = fullKey.split(':');
          if (keyParts.length >= 3 && keyParts[1] === 'instance') {
            const instanceKey = keyParts.slice(2).join(':'); // Handle cases where instanceId contains ':'
            
            // Skip keys that are not actual instance data (like connecting_time, restored)
            if (instanceKey.includes('connecting_time') || 
                instanceKey.includes('restored') || 
                instanceKey.includes('creds') ||
                instanceKey.includes('-')) {
              continue;
            }
            
            // Try to get instance data from cache using just the instanceKey
            this.logger.info(`Attempting to restore instance from key: ${instanceKey}`);
            
            try {
              const instanceData = await this.cache.get(instanceKey);
              if (instanceData) {
                const parsedData = typeof instanceData === 'string' ? JSON.parse(instanceData) : instanceData;
                
                // Validate that this looks like instance data
                if (parsedData && (parsedData.instanceName || parsedData.instanceId)) {
                  await this.restoreInstance(parsedData);
                  restored++;
                  this.logger.info(`Successfully restored instance: ${parsedData.instanceName || instanceKey}`);
                } else {
                  this.logger.warn(`Invalid instance data for key: ${instanceKey}`);
                }
              } else {
                this.logger.warn(`No data found for instance key: ${instanceKey}`);
              }
            } catch (redisError) {
              this.logger.warn(`Redis error for key ${instanceKey}, attempting database fallback: ${redisError?.toString()}`);
              
              // If Redis fails for this key, try to restore from database as fallback
              if (this.db.SAVE_DATA.INSTANCE) {
                const dbInstance = await this.findInstanceInDatabase(instanceKey);
                if (dbInstance) {
                  await this.restoreInstance(dbInstance);
                  restored++;
                  this.logger.info(`Successfully restored instance from database fallback: ${instanceKey}`);
                }
              }
            }
          }
        } catch (error) {
          this.logger.error(`Failed to restore instance from Redis key ${fullKey}: ${error?.toString()}`);
        }
      }

      this.logger.info(`Restored ${restored} instances from Redis cache`);
      return restored;

    } catch (error) {
      this.logger.error(`Failed to restore from Redis cache: ${error?.toString()}`);
      
      // If Redis completely fails, fall back to database restoration
      if (this.db.SAVE_DATA.INSTANCE) {
        this.logger.info('Redis cache failed, attempting fallback to database restoration');
        const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
        return await this.restoreFromDatabase(clientName);
      }
      
      return 0;
    }
  }

  private async restoreFromDatabase(clientName: string): Promise<number> {
    try {
      this.logger.info('Attempting to restore sessions from database');

      const instances = await this.prismaRepository.instance.findMany({
        where: { 
          clientName: clientName,
          // Only restore instances that were previously connected or trying to connect
          connectionStatus: { in: ['open', 'connecting'] }
        },
        include: {
          Webhook: true,
          Chatwoot: true,
          Proxy: true,
          Setting: true,
        },
      });

      if (instances.length === 0) {
        this.logger.info('No connected instances found in database for restoration');
        return 0;
      }

      this.logger.info(`Found ${instances.length} connected instances in database to restore`);

      let restored = 0;
      for (const instance of instances) {
        try {
          const instanceData: InstanceDto = {
            instanceId: instance.id,
            instanceName: instance.name,
            integration: instance.integration,
            token: instance.token,
            number: instance.number,
            businessId: instance.businessId,
            // Include webhook settings if available
            webhook: instance.Webhook ? {
              enabled: true,
              url: instance.Webhook.url,
              events: Array.isArray(instance.Webhook.events) 
                ? instance.Webhook.events.filter((event): event is string => typeof event === 'string')
                : [],
              byEvents: instance.Webhook.webhookByEvents,
              base64: instance.Webhook.webhookBase64,
            } : undefined,
            // Include chatwoot settings if available
            chatwootAccountId: instance.Chatwoot?.accountId,
            chatwootToken: instance.Chatwoot?.token,
            chatwootUrl: instance.Chatwoot?.url,
            chatwootNameInbox: instance.Chatwoot?.nameInbox,
            // Include proxy settings if available
            proxyHost: instance.Proxy?.host,
            proxyPort: instance.Proxy?.port,
            proxyProtocol: instance.Proxy?.protocol,
            proxyUsername: instance.Proxy?.username,
            proxyPassword: instance.Proxy?.password,
            // Include settings if available
            rejectCall: instance.Setting?.rejectCall,
            msgCall: instance.Setting?.msgCall,
            groupsIgnore: instance.Setting?.groupsIgnore,
            alwaysOnline: instance.Setting?.alwaysOnline,
            readMessages: instance.Setting?.readMessages,
            readStatus: instance.Setting?.readStatus,
          };

          await this.restoreInstance(instanceData);
          restored++;

        } catch (error) {
          this.logger.error(`Failed to restore instance ${instance.name}: ${error?.toString()}`);
        }
      }

      this.logger.info(`Restored ${restored} instances from database`);
      return restored;

    } catch (error) {
      this.logger.error(`Failed to restore from database: ${error?.toString()}`);
      return 0;
    }
  }

  private async restoreFromProviderFiles(): Promise<number> {
    try {
      this.logger.info('Attempting to restore sessions from provider files');
      // This would be implemented if provider files are enabled
      // For now, return 0 as it's not the primary restoration method
      return 0;
    } catch (error) {
      this.logger.error(`Failed to restore from provider files: ${error?.toString()}`);
      return 0;
    }
  }

  private async restoreInstance(instanceData: InstanceDto): Promise<void> {
    try {
      if (!instanceData.instanceName) {
        this.logger.warn('Skipping instance restoration: missing instanceName');
        return;
      }

      // Check if instance is already loaded
      if (this.waMonitor.waInstances[instanceData.instanceName]) {
        this.logger.info(`Instance ${instanceData.instanceName} already loaded, skipping`);
        return;
      }

      this.logger.info(`Restoring instance: ${instanceData.instanceName}`);

      // Use the setInstance method from WAMonitoringService to properly restore the instance
      await this.waMonitor.setInstance(instanceData);

      // Mark the instance as restored in cache for monitoring
      await this.cache.set(`restored:${instanceData.instanceName}`, 'true', 300);

      this.logger.info(`Successfully restored and connected instance: ${instanceData.instanceName}`);

    } catch (error) {
      this.logger.error(`Failed to restore instance ${instanceData.instanceName}: ${error?.toString()}`);
      throw error;
    }
  }

  private async verifyRestoredConnections(): Promise<void> {
    try {
      this.logger.info('Verifying restored connections');

      const instanceNames = Object.keys(this.waMonitor.waInstances);
      
      for (const instanceName of instanceNames) {
        const wasRestored = await this.cache.get(`restored:${instanceName}`);
        if (wasRestored) {
          // Give the instance some time to establish connection
          setTimeout(async () => {
            await this.verifyInstanceConnection(instanceName);
          }, 10000); // 10 seconds delay
        }
      }

    } catch (error) {
      this.logger.error(`Failed to verify restored connections: ${error?.toString()}`);
    }
  }

  private async verifyInstanceConnection(instanceName: string): Promise<void> {
    try {
      const instance = this.waMonitor.waInstances[instanceName];
      if (!instance) {
        this.logger.warn(`Instance ${instanceName} not found for verification`);
        return;
      }

      const connectionStatus = instance.connectionStatus;
      
      if (connectionStatus?.state === 'open') {
        this.logger.info(`Instance ${instanceName} successfully restored and connected`);
        
        // Verify that the instance is actually functional by checking if it has required properties
        if (instance.client && instance.instanceId) {
          this.logger.info(`Instance ${instanceName} verification passed - client and instanceId present`);
        } else {
          this.logger.warn(`Instance ${instanceName} missing critical properties, may need reconnection`);
          await this.attemptReconnection(instanceName, instance);
        }
      } else if (connectionStatus?.state === 'connecting') {
        this.logger.info(`Instance ${instanceName} is still connecting after restoration`);
        // Set up a timeout to check again later
        setTimeout(async () => {
          await this.verifyInstanceConnection(instanceName);
        }, 30000); // Check again in 30 seconds
      } else {
        this.logger.warn(`Instance ${instanceName} failed to connect after restoration (state: ${connectionStatus?.state}), attempting reconnect`);
        await this.attemptReconnection(instanceName, instance);
      }

      // Clean up the restoration marker
      await this.cache.delete(`restored:${instanceName}`);

    } catch (error) {
      this.logger.error(`Failed to verify connection for ${instanceName}: ${error?.toString()}`);
    }
  }

  private async attemptReconnection(instanceName: string, instance: any): Promise<void> {
    try {
      this.logger.info(`Attempting reconnection for instance ${instanceName}`);
      
      if (instance.integration === Integration.WHATSAPP_BAILEYS) {
        await instance.connectToWhatsapp(instance.phoneNumber);
      }

    } catch (error) {
      this.logger.error(`Failed to reconnect instance ${instanceName}: ${error?.toString()}`);
    }
  }

  /**
   * Save instance state to multiple persistence layers for redundancy
   */
  public async persistInstanceState(instanceName: string, instanceData: any): Promise<void> {
    try {
      // Save to Redis if enabled
      if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
        const cacheKey = instanceData.instanceId || instanceName;
        // Set TTL to 0 (no expiration) for instance session data to prevent premature expiration
        // This ensures sessions are not lost due to TTL timeout
        await this.cache.set(cacheKey, instanceData, 0); // No TTL
        this.logger.info(`Saved instance state to Redis: ${instanceName} (${cacheKey}) - no TTL expiration`);
      }

      // Update database status if enabled
      if (this.db.SAVE_DATA.INSTANCE && instanceData.instanceId) {
        await this.prismaRepository.instance.update({
          where: { id: instanceData.instanceId },
          data: {
            connectionStatus: instanceData.connectionStatus || 'open',
            ownerJid: instanceData.ownerJid,
            profileName: instanceData.profileName,
            profilePicUrl: instanceData.profilePicUrl,
            number: instanceData.number,
          },
        });
        this.logger.info(`Updated instance state in database: ${instanceName}`);
      }

    } catch (error) {
      this.logger.error(`Failed to persist instance state for ${instanceName}: ${error?.toString()}`);
    }
  }

  /**
   * Remove instance from all persistence layers
   */
  public async removeInstanceState(instanceName: string, instanceId?: string): Promise<void> {
    try {
      // Remove from Redis if enabled
      if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES && instanceId) {
        await this.cache.delete(instanceId);
        this.logger.info(`Removed instance state from Redis: ${instanceName} (${instanceId})`);
      }

      // Clear any restoration markers
      await this.cache.delete(`restored:${instanceName}`);
      await this.cache.delete(`connecting_time:${instanceName}`);

    } catch (error) {
      this.logger.error(`Failed to remove instance state for ${instanceName}: ${error?.toString()}`);
    }
  }

  /**
   * Validate session health and check for potential issues
   */
  public async validateSessionHealth(): Promise<void> {
    try {
      this.logger.info('Starting session health validation');
      
      const instances = Object.keys(this.waMonitor.waInstances);
      let healthyCount = 0;
      let unhealthyCount = 0;
      
      for (const instanceName of instances) {
        const instance = this.waMonitor.waInstances[instanceName];
        
        if (!instance) {
          this.logger.warn(`Instance ${instanceName} exists in waInstances but is null/undefined`);
          unhealthyCount++;
          continue;
        }
        
        const connectionState = instance.connectionStatus?.state;
        
        if (connectionState === 'open') {
          // Check if the instance has required properties for a healthy session
          if (instance.client && instance.instanceId && instance.instance?.wuid) {
            healthyCount++;
            
            // Persist healthy session state to ensure it's not lost
            const instanceData = {
              instanceId: instance.instanceId,
              instanceName: instanceName,
              integration: instance.integration,
              token: instance.token,
              number: instance.number,
              businessId: instance.businessId,
              connectionStatus: 'open',
              ownerJid: instance.instance.wuid,
              profileName: instance.instance.profileName,
              profilePicUrl: instance.instance.profilePictureUrl,
            };
            
            await this.persistInstanceState(instanceName, instanceData);
            
          } else {
            this.logger.warn(`Instance ${instanceName} appears connected but missing critical properties`);
            unhealthyCount++;
          }
        } else {
          this.logger.warn(`Instance ${instanceName} has unhealthy connection state: ${connectionState}`);
          unhealthyCount++;
        }
      }
      
      this.logger.info(`Session health check completed: ${healthyCount} healthy, ${unhealthyCount} unhealthy instances`);
      
    } catch (error) {
      this.logger.error(`Session health validation failed: ${error?.toString()}`);
    }
  }

  /**
   * Find a specific instance in the database by instance ID or name
   */
  private async findInstanceInDatabase(instanceKey: string): Promise<InstanceDto | null> {
    try {
      const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
      
      // Try to find by ID first, then by name
      const instance = await this.prismaRepository.instance.findFirst({
        where: {
          OR: [
            { id: instanceKey, clientName },
            { name: instanceKey, clientName }
          ],
          connectionStatus: { in: ['open', 'connecting'] }
        },
        include: {
          Webhook: true,
          Chatwoot: true,
          Proxy: true,
          Setting: true,
        },
      });

      if (!instance) {
        return null;
      }

      return {
        instanceId: instance.id,
        instanceName: instance.name,
        integration: instance.integration,
        token: instance.token,
        number: instance.number,
        businessId: instance.businessId,
        webhook: instance.Webhook ? {
          enabled: true,
          url: instance.Webhook.url,
          events: Array.isArray(instance.Webhook.events) 
            ? instance.Webhook.events.filter((event): event is string => typeof event === 'string')
            : [],
          byEvents: instance.Webhook.webhookByEvents,
          base64: instance.Webhook.webhookBase64,
        } : undefined,
        chatwootAccountId: instance.Chatwoot?.accountId,
        chatwootToken: instance.Chatwoot?.token,
        chatwootUrl: instance.Chatwoot?.url,
        chatwootNameInbox: instance.Chatwoot?.nameInbox,
        proxyHost: instance.Proxy?.host,
        proxyPort: instance.Proxy?.port,
        proxyProtocol: instance.Proxy?.protocol,
        proxyUsername: instance.Proxy?.username,
        proxyPassword: instance.Proxy?.password,
        rejectCall: instance.Setting?.rejectCall,
        msgCall: instance.Setting?.msgCall,
        groupsIgnore: instance.Setting?.groupsIgnore,
        alwaysOnline: instance.Setting?.alwaysOnline,
        readMessages: instance.Setting?.readMessages,
        readStatus: instance.Setting?.readStatus,
      };
    } catch (error) {
      this.logger.error(`Failed to find instance ${instanceKey} in database: ${error?.toString()}`);
      return null;
    }
  }
}