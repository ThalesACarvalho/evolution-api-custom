import { InstanceDto } from '@api/dto/instance.dto';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { channelController } from '@api/server.module';
import { Events, Integration } from '@api/types/wa.types';
import { CacheConf, Chatwoot, ConfigService, Database, DelInstance, ProviderSession } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { INSTANCE_DIR, STORE_DIR } from '@config/path.config';
import { NotFoundException } from '@exceptions';
import { execFileSync } from 'child_process';
import EventEmitter2 from 'eventemitter2';
import { rmSync } from 'fs';
import { join } from 'path';

import { CacheService } from './cache.service';
import { SessionRestorationService } from './session-restoration.service';

export class WAMonitoringService {
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly providerFiles: ProviderFiles,
    private readonly cache: CacheService,
    private readonly chatwootCache: CacheService,
    private readonly baileysCache: CacheService,
  ) {
    this.removeInstance();
    this.noConnection();

    Object.assign(this.db, configService.get<Database>('DATABASE'));
    Object.assign(this.redis, configService.get<CacheConf>('CACHE'));
  }

  private readonly db: Partial<Database> = {};
  private readonly redis: Partial<CacheConf> = {};

  private readonly logger = new Logger('WAMonitoringService');
  public readonly waInstances: Record<string, any> = {};

  private readonly providerSession = Object.freeze(this.configService.get<ProviderSession>('PROVIDER'));

  public delInstanceTime(instance: string) {
    const time = this.configService.get<DelInstance>('DEL_INSTANCE');
    if (typeof time === 'number' && time > 0) {
      setTimeout(
        async () => {
          if (this.waInstances[instance]?.connectionStatus?.state !== 'open') {
            // Check if the instance is still trying to connect
            if (this.waInstances[instance]?.connectionStatus?.state === 'connecting') {
              const connectingDuration = Date.now() - (this.waInstances[instance]?.connectingStartTime || 0);

              this.logger.info(`Instance ${instance} connecting for ${connectingDuration}ms`);

              // Allow more time for connection if it's still within reasonable limits
              if (connectingDuration < 300000) {
                // 5 minutes
                this.logger.info(`Instance ${instance} still connecting, extending timeout`);
                this.delInstanceTime(instance); // Reschedule
                return;
              }

              // Check if there are Redis/Cache issues before forcing logout
              const cacheAvailable = await this.checkCacheAvailability(instance);
              if (!cacheAvailable) {
                this.logger.warn(
                  `Instance ${instance} connection timeout but cache unavailable, attempting recovery instead of logout`,
                );

                // Try to recover the session instead of logging out
                try {
                  const sessionRestoration = new SessionRestorationService(
                    this,
                    this.cache,
                    this.prismaRepository,
                    this.configService,
                  );

                  // Try to restore from database as fallback
                  const restored = await sessionRestoration.restoreFromDatabase(
                    this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME,
                  );

                  if (restored > 0) {
                    this.logger.info(`Successfully recovered instance ${instance} from database`);
                    return;
                  }
                } catch (error) {
                  this.logger.error(`Failed to recover instance ${instance}: ${error?.toString()}`);
                }
              }

              // Only force logout if we've exhausted recovery options
              this.logger.warn(
                `Forcing logout for instance ${instance} after ${connectingDuration}ms connection timeout`,
              );

              if ((await this.waInstances[instance].integration) === Integration.WHATSAPP_BAILEYS) {
                await this.waInstances[instance]?.client?.logout(
                  'Connection timeout after ' + connectingDuration + 'ms: ' + instance,
                );
                this.waInstances[instance]?.client?.ws?.close();
                this.waInstances[instance]?.client?.end(undefined);
              }
              this.eventEmitter.emit('remove.instance', instance, 'timeout');
            } else {
              // Instance is closed, remove it
              this.logger.info(`Removing closed instance: ${instance}`);
              this.eventEmitter.emit('remove.instance', instance, 'closed');
            }
          }
        },
        1000 * 60 * time,
      );
    }
  }

  public async instanceInfo(instanceNames?: string[]): Promise<any> {
    if (instanceNames && instanceNames.length > 0) {
      const inexistentInstances = instanceNames ? instanceNames.filter((instance) => !this.waInstances[instance]) : [];

      if (inexistentInstances.length > 0) {
        throw new NotFoundException(
          `Instance${inexistentInstances.length > 1 ? 's' : ''} "${inexistentInstances.join(', ')}" not found`,
        );
      }
    }

    const clientName = this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;

    const where =
      instanceNames && instanceNames.length > 0
        ? {
            name: {
              in: instanceNames,
            },
            clientName,
          }
        : { clientName };

    const instances = await this.prismaRepository.instance.findMany({
      where,
      include: {
        Chatwoot: true,
        Proxy: true,
        Rabbitmq: true,
        Nats: true,
        Sqs: true,
        Websocket: true,
        Setting: true,
        _count: {
          select: {
            Message: true,
            Contact: true,
            Chat: true,
          },
        },
      },
    });

    return instances;
  }

  public async instanceInfoById(instanceId?: string, number?: string) {
    let instanceName: string;
    if (instanceId) {
      instanceName = await this.prismaRepository.instance.findFirst({ where: { id: instanceId } }).then((r) => r?.name);
      if (!instanceName) {
        throw new NotFoundException(`Instance "${instanceId}" not found`);
      }
    } else if (number) {
      instanceName = await this.prismaRepository.instance.findFirst({ where: { number } }).then((r) => r?.name);
      if (!instanceName) {
        throw new NotFoundException(`Instance "${number}" not found`);
      }
    }

    if (!instanceName) {
      throw new NotFoundException(`Instance "${instanceId}" not found`);
    }

    if (instanceName && !this.waInstances[instanceName]) {
      throw new NotFoundException(`Instance "${instanceName}" not found`);
    }

    const instanceNames = instanceName ? [instanceName] : null;

    return this.instanceInfo(instanceNames);
  }

  public async cleaningUp(instanceName: string) {
    let instanceDbId: string;
    if (this.db.SAVE_DATA.INSTANCE) {
      const findInstance = await this.prismaRepository.instance.findFirst({
        where: { name: instanceName },
      });

      if (findInstance) {
        const instance = await this.prismaRepository.instance.update({
          where: { name: instanceName },
          data: { connectionStatus: 'close' },
        });

        rmSync(join(INSTANCE_DIR, instance.id), { recursive: true, force: true });

        instanceDbId = instance.id;
        await this.prismaRepository.session.deleteMany({ where: { sessionId: instance.id } });
      }
    }

    if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
      await this.cache.delete(instanceName);
      if (instanceDbId) {
        await this.cache.delete(instanceDbId);
      }
    }

    if (this.providerSession?.ENABLED) {
      await this.providerFiles.removeSession(instanceName);
    }
  }

  public async cleaningStoreData(instanceName: string) {
    if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
      const instancePath = join(STORE_DIR, 'chatwoot', instanceName);
      execFileSync('rm', ['-rf', instancePath]);
    }

    const instance = await this.prismaRepository.instance.findFirst({
      where: { name: instanceName },
    });

    if (!instance) return;

    rmSync(join(INSTANCE_DIR, instance.id), { recursive: true, force: true });

    await this.prismaRepository.session.deleteMany({ where: { sessionId: instance.id } });

    await this.prismaRepository.chat.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.contact.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.messageUpdate.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.message.deleteMany({ where: { instanceId: instance.id } });

    await this.prismaRepository.webhook.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.chatwoot.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.proxy.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.rabbitmq.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.nats.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.sqs.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.integrationSession.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.typebot.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.websocket.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.setting.deleteMany({ where: { instanceId: instance.id } });
    await this.prismaRepository.label.deleteMany({ where: { instanceId: instance.id } });

    await this.prismaRepository.instance.delete({ where: { name: instanceName } });
  }

  public async loadInstance() {
    try {
      this.logger.info('Starting instance loading process with enhanced session restoration');

      if (this.providerSession?.ENABLED) {
        await this.loadInstancesFromProvider();
      } else if (this.db.SAVE_DATA.INSTANCE) {
        await this.loadInstancesFromDatabasePostgres();
      } else if (this.redis.REDIS.ENABLED && this.redis.REDIS.SAVE_INSTANCES) {
        await this.loadInstancesFromRedis();
      }

      this.logger.info('Instance loading completed');
    } catch (error) {
      this.logger.error(`Instance loading failed: ${error?.toString()}`);
      throw error;
    }
  }

  public async saveInstance(data: any) {
    try {
      const clientName = await this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;
      await this.prismaRepository.instance.create({
        data: {
          id: data.instanceId,
          name: data.instanceName,
          ownerJid: data.ownerJid,
          profileName: data.profileName,
          profilePicUrl: data.profilePicUrl,
          connectionStatus:
            data.integration && data.integration === Integration.WHATSAPP_BAILEYS ? 'close' : (data.status ?? 'open'),
          number: data.number,
          integration: data.integration || Integration.WHATSAPP_BAILEYS,
          token: data.hash,
          clientName: clientName,
          businessId: data.businessId,
        },
      });
    } catch (error) {
      this.logger.error(error);
    }
  }

  public deleteInstance(instanceName: string) {
    try {
      this.eventEmitter.emit('remove.instance', instanceName, 'inner');
    } catch (error) {
      this.logger.error(error);
    }
  }

  public async setInstance(instanceData: InstanceDto) {
    const instance = channelController.init(instanceData, {
      configService: this.configService,
      eventEmitter: this.eventEmitter,
      prismaRepository: this.prismaRepository,
      cache: this.cache,
      chatwootCache: this.chatwootCache,
      baileysCache: this.baileysCache,
      providerFiles: this.providerFiles,
    });

    if (!instance) return;

    instance.setInstance({
      instanceId: instanceData.instanceId,
      instanceName: instanceData.instanceName,
      integration: instanceData.integration,
      token: instanceData.token,
      number: instanceData.number,
      businessId: instanceData.businessId,
    });

    await instance.connectToWhatsapp();

    this.waInstances[instanceData.instanceName] = instance;
  }

  private async loadInstancesFromRedis() {
    const keys = await this.cache.keys();

    if (keys?.length > 0) {
      await Promise.all(
        keys.map(async (k) => {
          const instanceData = await this.prismaRepository.instance.findUnique({
            where: { id: k.split(':')[1] },
          });

          if (!instanceData) {
            return;
          }

          const instance = {
            instanceId: k.split(':')[1],
            instanceName: k.split(':')[2],
            integration: instanceData.integration,
            token: instanceData.token,
            number: instanceData.number,
            businessId: instanceData.businessId,
          };

          this.setInstance(instance);
        }),
      );
    }
  }

  private async loadInstancesFromDatabasePostgres() {
    const clientName = await this.configService.get<Database>('DATABASE').CONNECTION.CLIENT_NAME;

    const instances = await this.prismaRepository.instance.findMany({
      where: { clientName: clientName },
    });

    if (instances.length === 0) {
      return;
    }

    await Promise.all(
      instances.map(async (instance) => {
        this.setInstance({
          instanceId: instance.id,
          instanceName: instance.name,
          integration: instance.integration,
          token: instance.token,
          number: instance.number,
          businessId: instance.businessId,
        });
      }),
    );
  }

  private async loadInstancesFromProvider() {
    const [instances] = await this.providerFiles.allInstances();

    if (!instances?.data) {
      return;
    }

    await Promise.all(
      instances?.data?.map(async (instanceId: string) => {
        const instance = await this.prismaRepository.instance.findUnique({
          where: { id: instanceId },
        });

        this.setInstance({
          instanceId: instance.id,
          instanceName: instance.name,
          integration: instance.integration,
          token: instance.token,
          businessId: instance.businessId,
        });
      }),
    );
  }

  private removeInstance() {
    this.eventEmitter.on('remove.instance', async (instanceName: string, reason?: string) => {
      this.logger.warn(
        `[REMOVE_INSTANCE_EVENT] Instance "${instanceName}" - Remove event triggered with reason: ${reason || 'unknown'}`,
      );

      try {
        await this.waInstances[instanceName]?.sendDataWebhook(Events.REMOVE_INSTANCE, null);

        // Clean up session state before removing instance
        const instanceId = this.waInstances[instanceName]?.instanceId;
        this.eventEmitter.emit('instance.state.remove', instanceName, instanceId);

        this.cleaningUp(instanceName);
        this.cleaningStoreData(instanceName);
      } finally {
        this.logger.warn(`[REMOVE_INSTANCE_COMPLETE] Instance "${instanceName}" - REMOVED`);
      }

      try {
        delete this.waInstances[instanceName];
      } catch (error) {
        this.logger.error(error);
      }
    });
    this.eventEmitter.on('logout.instance', async (instanceName: string, reason?: string) => {
      this.logger.warn(
        `[LOGOUT_INSTANCE_EVENT] Instance "${instanceName}" - Logout event triggered with reason: ${reason || 'unknown'}`,
      );

      try {
        await this.waInstances[instanceName]?.sendDataWebhook(Events.LOGOUT_INSTANCE, null);

        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) {
          this.waInstances[instanceName]?.clearCacheChatwoot();
        }

        this.cleaningUp(instanceName);
      } finally {
        this.logger.warn(`[LOGOUT_INSTANCE_COMPLETE] Instance "${instanceName}" - LOGOUT`);
      }
    });
  }

  private noConnection() {
    this.eventEmitter.on('no.connection', async (instanceName) => {
      this.logger.warn(`[NO_CONNECTION_EVENT] Instance "${instanceName}" - No connection event triggered`);

      try {
        await this.waInstances[instanceName]?.client?.logout('Log out instance: ' + instanceName);

        this.waInstances[instanceName]?.client?.ws?.close();

        this.waInstances[instanceName].instance.qrcode = { count: 0 };
        this.waInstances[instanceName].stateConnection.state = 'close';

        this.logger.warn(`[NO_CONNECTION_STATE_SET] Instance "${instanceName}" - State forcibly set to 'close'`);
      } catch (error) {
        this.logger.error({
          localError: 'noConnection',
          warn: 'Error deleting instance from memory.',
          error,
        });
      } finally {
        this.logger.warn(`[NO_CONNECTION_COMPLETE] Instance "${instanceName}" - NOT CONNECTION`);
      }
    });
  }

  /**
   * Check if cache/Redis is available and working
   */
  private async checkCacheAvailability(instanceName: string): Promise<boolean> {
    try {
      if (!this.cache) {
        return false;
      }

      // Try a simple cache operation to test availability
      const testKey = `test:${instanceName}:${Date.now()}`;
      await this.cache.set(testKey, 'test', 5); // 5 second TTL
      const result = await this.cache.get(testKey);
      await this.cache.delete(testKey);

      return result === 'test';
    } catch (error) {
      this.logger.warn(`Cache availability check failed for ${instanceName}: ${error?.toString()}`);
      return false;
    }
  }
}
