import { CacheService } from '@api/services/cache.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
import { Logger } from '@config/logger.config';
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
      this.logger.error(`Health check failed: ${error?.toString()}`);
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

      this.logger.debug(`[HEALTH_CHECK] Instance ${instanceName}: Status = ${connectionStatus?.state}`);

      // Check if connection status claims to be open but WebSocket is closed
      if (connectionStatus?.state === 'open') {
        const isWebSocketOpen = this.isWebSocketHealthy(client);

        if (!isWebSocketOpen) {
          this.logger.warn(
            `[HEALTH_MISMATCH] Instance ${instanceName}: Connection status mismatch detected - claims open but WebSocket unhealthy`,
          );
          await this.handleConnectionMismatch(instanceName, instance);
          return;
        }

        // Perform ping test for open connections
        const isPingSuccessful = await this.performPingTest(instanceName, client);
        if (!isPingSuccessful) {
          this.logger.warn(`[HEALTH_PING_FAIL] Instance ${instanceName}: Ping test failed for 'open' connection`);
          await this.handleConnectionFailure(instanceName, instance);
        } else {
          this.logger.debug(`[HEALTH_OK] Instance ${instanceName}: Connection healthy`);
        }
      }

      // Check for connections marked as closed but actually still connected
      if (connectionStatus?.state === 'close') {
        const isWebSocketOpen = this.isWebSocketHealthy(client);
        const hasValidClient = client && client.user && client.user.id;

        if (isWebSocketOpen && hasValidClient) {
          this.logger.warn(
            `[HEALTH_FALSE_CLOSE] Instance ${instanceName}: Marked as closed but client appears connected - correcting state`,
          );
          await this.correctFalseDisconnection(instanceName, instance);
          return;
        }
      }

      // Check for stuck connecting state
      if (connectionStatus?.state === 'connecting') {
        const connectingTime = await this.getConnectingTime(instanceName);
        if (connectingTime && Date.now() - connectingTime > this.CONNECTION_TIMEOUT) {
          this.logger.warn(
            `[HEALTH_TIMEOUT] Instance ${instanceName}: Connection timeout detected after ${this.CONNECTION_TIMEOUT}ms`,
          );
          await this.handleConnectionTimeout(instanceName, instance);
        }
      }
    } catch (error) {
      this.logger.error(`Health check failed for instance ${instanceName}: ${error?.toString()}`);
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
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Ping timeout')), 10000));

      const pingTest = client.user ? Promise.resolve(client.user) : Promise.reject(new Error('No user'));

      await Promise.race([pingTest, timeout]);
      return true;
    } catch (error) {
      this.logger.debug(`Ping test failed for ${instanceName}: ${error.message}`);
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
      this.logger.error(`Failed to handle connection mismatch for ${instanceName}: ${error?.toString()}`);
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
      this.logger.error(`Failed to handle connection failure for ${instanceName}: ${error?.toString()}`);
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
      this.logger.error(`Failed to handle connection timeout for ${instanceName}: ${error?.toString()}`);
    }
  }

  private async correctFalseDisconnection(instanceName: string, instance: any) {
    try {
      this.logger.info(
        `[CORRECT_FALSE_DISCONNECT] Instance ${instanceName}: Correcting false disconnection - client appears healthy`,
      );

      // Verify the client is really connected by performing a simple test
      const isReallyConnected = await this.performPingTest(instanceName, instance.client);

      if (isReallyConnected) {
        this.logger.info(
          `[CORRECT_FALSE_DISCONNECT] Instance ${instanceName}: Confirmed client is connected, restoring 'open' state`,
        );

        // Restore the connection state to open
        instance.stateConnection.state = 'open';

        // Update database to reflect correct status
        try {
          await instance.prismaRepository.instance.update({
            where: { id: instance.instanceId },
            data: { connectionStatus: 'open' },
          });
        } catch (error) {
          this.logger.error(
            `[CORRECT_FALSE_DISCONNECT] Failed to update database for ${instanceName}: ${error?.toString()}`,
          );
        }

        // Send webhook notification about the correction
        try {
          await instance.sendDataWebhook('CONNECTION_UPDATE', {
            instance: instanceName,
            state: 'open',
            corrected: true,
            message: 'False disconnection corrected by health monitor',
          });
        } catch (error) {
          this.logger.error(
            `[CORRECT_FALSE_DISCONNECT] Failed to send webhook for ${instanceName}: ${error?.toString()}`,
          );
        }

        this.logger.info(
          `[CORRECT_FALSE_DISCONNECT] Instance ${instanceName}: Successfully corrected false disconnection`,
        );
      } else {
        this.logger.warn(
          `[CORRECT_FALSE_DISCONNECT] Instance ${instanceName}: Client verification failed, connection is actually closed`,
        );
        await this.handleConnectionFailure(instanceName, instance);
      }
    } catch (error) {
      this.logger.error(
        `[CORRECT_FALSE_DISCONNECT] Failed to correct false disconnection for ${instanceName}: ${error?.toString()}`,
      );
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
      this.logger.error(`Failed to set connecting time for ${instanceName}: ${error?.toString()}`);
    }
  }

  private async clearConnectingTime(instanceName: string): Promise<void> {
    try {
      await this.cache.delete(`connecting_time:${instanceName}`);
    } catch (error) {
      this.logger.error(`Failed to clear connecting time for ${instanceName}: ${error?.toString()}`);
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
