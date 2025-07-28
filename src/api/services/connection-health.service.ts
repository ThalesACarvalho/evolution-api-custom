import { Logger } from '@config/logger.config';
import { Events, Integration } from '@api/types/wa.types';
import { CacheService } from '@api/services/cache.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import cron from 'node-cron';

export class ConnectionHealthService {
  private readonly logger = new Logger('ConnectionHealthService');
  private healthCheckJob: any;
  private readonly HEALTH_CHECK_INTERVAL = '*/30 * * * * *'; // Every 30 seconds
  private readonly CONNECTION_TIMEOUT = 120000; // 2 minutes

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly cache: CacheService,
  ) {
    this.startHealthMonitoring();
  }

  private startHealthMonitoring() {
    this.healthCheckJob = cron.schedule(
      this.HEALTH_CHECK_INTERVAL,
      async () => {
        await this.performHealthChecks();
      },
      {
        scheduled: true,
        name: 'connection-health-check',
      },
    );

    this.logger.info('Connection health monitoring started');
  }

  private async performHealthChecks() {
    try {
      const instances = Object.keys(this.waMonitor.waInstances);
      
      for (const instanceName of instances) {
        const instance = this.waMonitor.waInstances[instanceName];
        
        if (!instance) continue;

        await this.checkInstanceHealth(instanceName, instance);
      }
    } catch (error) {
      this.logger.error('Health check failed:', error);
    }
  }

  private async checkInstanceHealth(instanceName: string, instance: any) {
    try {
      // Skip if integration is not Baileys
      if (instance.integration !== Integration.WHATSAPP_BAILEYS) {
        return;
      }

      const connectionStatus = instance.connectionStatus;
      const client = instance.client;

      // Check if connection status claims to be open but WebSocket is closed
      if (connectionStatus?.state === 'open') {
        const isWebSocketOpen = this.isWebSocketHealthy(client);
        
        if (!isWebSocketOpen) {
          this.logger.warn(`Instance ${instanceName}: Connection status mismatch detected`);
          await this.handleConnectionMismatch(instanceName, instance);
          return;
        }

        // Perform ping test for open connections
        const isPingSuccessful = await this.performPingTest(instanceName, client);
        if (!isPingSuccessful) {
          this.logger.warn(`Instance ${instanceName}: Ping test failed`);
          await this.handleConnectionFailure(instanceName, instance);
        }
      }

      // Check for stuck connecting state
      if (connectionStatus?.state === 'connecting') {
        const connectingTime = await this.getConnectingTime(instanceName);
        if (connectingTime && Date.now() - connectingTime > this.CONNECTION_TIMEOUT) {
          this.logger.warn(`Instance ${instanceName}: Connection timeout detected`);
          await this.handleConnectionTimeout(instanceName, instance);
        }
      }

    } catch (error) {
      this.logger.error(`Health check failed for instance ${instanceName}:`, error);
    }
  }

  private isWebSocketHealthy(client: any): boolean {
    if (!client?.ws) return false;
    
    const wsState = client.ws.readyState;
    return wsState === 1; // WebSocket.OPEN
  }

  private async performPingTest(instanceName: string, client: any): Promise<boolean> {
    try {
      if (!client || !client.ws || client.ws.readyState !== 1) {
        return false;
      }

      // Simple ping test - check if we can get user info
      const timeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Ping timeout')), 10000)
      );

      const pingTest = client.user ? Promise.resolve(client.user) : Promise.reject(new Error('No user'));

      await Promise.race([pingTest, timeout]);
      return true;
    } catch (error) {
      this.logger.debug(`Ping test failed for ${instanceName}:`, error.message);
      return false;
    }
  }

  private async handleConnectionMismatch(instanceName: string, instance: any) {
    try {
      this.logger.info(`Attempting to reconnect instance ${instanceName} due to connection mismatch`);
      
      // Update connection status to reflect reality
      instance.stateConnection.state = 'close';
      
      // Trigger reconnection
      await instance.connectToWhatsapp(instance.phoneNumber);
      
    } catch (error) {
      this.logger.error(`Failed to handle connection mismatch for ${instanceName}:`, error);
    }
  }

  private async handleConnectionFailure(instanceName: string, instance: any) {
    try {
      this.logger.info(`Handling connection failure for instance ${instanceName}`);
      
      // Close the WebSocket properly
      if (instance.client?.ws) {
        instance.client.ws.close();
      }
      
      // Update status and reconnect
      instance.stateConnection.state = 'close';
      await instance.connectToWhatsapp(instance.phoneNumber);
      
    } catch (error) {
      this.logger.error(`Failed to handle connection failure for ${instanceName}:`, error);
    }
  }

  private async handleConnectionTimeout(instanceName: string, instance: any) {
    try {
      this.logger.info(`Handling connection timeout for instance ${instanceName}`);
      
      // Reset connection state
      if (instance.client?.ws) {
        instance.client.ws.close();
      }
      
      // Clear connecting timestamp
      await this.clearConnectingTime(instanceName);
      
      // Restart connection process
      instance.stateConnection.state = 'close';
      await instance.connectToWhatsapp(instance.phoneNumber);
      
    } catch (error) {
      this.logger.error(`Failed to handle connection timeout for ${instanceName}:`, error);
    }
  }

  private async getConnectingTime(instanceName: string): Promise<number | null> {
    try {
      const timestamp = await this.cache.get(`connecting_time:${instanceName}`);
      return timestamp ? parseInt(timestamp) : null;
    } catch (error) {
      return null;
    }
  }

  private async setConnectingTime(instanceName: string): Promise<void> {
    try {
      await this.cache.set(`connecting_time:${instanceName}`, Date.now().toString(), 300); // 5 minutes TTL
    } catch (error) {
      this.logger.error(`Failed to set connecting time for ${instanceName}:`, error);
    }
  }

  private async clearConnectingTime(instanceName: string): Promise<void> {
    try {
      await this.cache.delete(`connecting_time:${instanceName}`);
    } catch (error) {
      this.logger.error(`Failed to clear connecting time for ${instanceName}:`, error);
    }
  }

  public async onInstanceConnecting(instanceName: string): Promise<void> {
    await this.setConnectingTime(instanceName);
  }

  public async onInstanceConnected(instanceName: string): Promise<void> {
    await this.clearConnectingTime(instanceName);
  }

  public stopHealthMonitoring() {
    if (this.healthCheckJob) {
      this.healthCheckJob.destroy();
      this.logger.info('Connection health monitoring stopped');
    }
  }
}