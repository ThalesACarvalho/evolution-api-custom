import { Logger } from '@config/logger.config';
import { WAMonitoringService } from '@api/services/monitor.service';
import { SessionRestorationService } from '@api/services/session-restoration.service';
import { ConnectionHealthService } from '@api/services/connection-health.service';
import { Integration } from '@api/types/wa.types';

export class GracefulShutdownService {
  private readonly logger = new Logger('GracefulShutdownService');
  private isShuttingDown = false;
  private shutdownTimeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly sessionRestorationService: SessionRestorationService,
    private readonly connectionHealthService: ConnectionHealthService,
  ) {
    this.setupSignalHandlers();
  }

  private setupSignalHandlers(): void {
    // Handle SIGTERM (Docker/Kubernetes shutdown)
    process.on('SIGTERM', () => {
      this.logger.info('Received SIGTERM signal, initiating graceful shutdown');
      this.initiateShutdown();
    });

    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      this.logger.info('Received SIGINT signal, initiating graceful shutdown');
      this.initiateShutdown();
    });

    // Handle SIGHUP (Terminal closed)
    process.on('SIGHUP', () => {
      this.logger.info('Received SIGHUP signal, initiating graceful shutdown');
      this.initiateShutdown();
    });

    this.logger.info('Signal handlers registered for graceful shutdown');
  }

  private async initiateShutdown(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress, ignoring signal');
      return;
    }

    this.isShuttingDown = true;

    // Set a timeout to force exit if graceful shutdown takes too long
    this.shutdownTimeout = setTimeout(() => {
      this.logger.error('Graceful shutdown timeout reached, forcing exit');
      process.exit(1);
    }, 30000); // 30 seconds timeout

    try {
      await this.performGracefulShutdown();
      this.logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      this.logger.error(`Error during graceful shutdown: ${error?.toString()}`);
      process.exit(1);
    } finally {
      if (this.shutdownTimeout) {
        clearTimeout(this.shutdownTimeout);
      }
    }
  }

  private async performGracefulShutdown(): Promise<void> {
    const startTime = Date.now();
    this.logger.info('Starting graceful shutdown process');

    try {
      // Step 1: Stop health monitoring
      this.connectionHealthService.stopHealthMonitoring();
      this.logger.info('Health monitoring stopped');

      // Step 2: Save all active instance states
      await this.saveAllInstanceStates();

      // Step 3: Gracefully close all WebSocket connections
      await this.closeAllConnections();

      // Step 4: Clean up resources
      await this.cleanupResources();

      const shutdownTime = Date.now() - startTime;
      this.logger.info(`Graceful shutdown completed in ${shutdownTime}ms`);

    } catch (error) {
      this.logger.error(`Error during graceful shutdown process: ${error?.toString()}`);
      throw error;
    }
  }

  private async saveAllInstanceStates(): Promise<void> {
    try {
      this.logger.info('Saving all instance states before shutdown');

      const instances = Object.keys(this.waMonitor.waInstances);
      const savePromises = instances.map(async (instanceName) => {
        try {
          const instance = this.waMonitor.waInstances[instanceName];
          if (!instance) return;

          const instanceData = {
            instanceId: instance.instanceId,
            instanceName: instanceName,
            integration: instance.integration,
            connectionStatus: instance.connectionStatus?.state || 'close',
            ownerJid: instance.instance?.wuid,
            profileName: instance.instance?.profileName,
            profilePicUrl: instance.instance?.profilePictureUrl,
            number: instance.phoneNumber,
            token: instance.instance?.token,
            businessId: instance.instance?.businessId,
          };

          await this.sessionRestorationService.persistInstanceState(instanceName, instanceData);
          this.logger.debug(`Saved state for instance: ${instanceName}`);

        } catch (error) {
          this.logger.error(`Failed to save state for instance ${instanceName}: ${error?.toString()}`);
        }
      });

      await Promise.allSettled(savePromises);
      this.logger.info(`Attempted to save ${instances.length} instance states`);

    } catch (error) {
      this.logger.error(`Failed to save instance states: ${error?.toString()}`);
      throw error;
    }
  }

  private async closeAllConnections(): Promise<void> {
    try {
      this.logger.info('Closing all WhatsApp connections');

      const instances = Object.keys(this.waMonitor.waInstances);
      const closePromises = instances.map(async (instanceName) => {
        try {
          const instance = this.waMonitor.waInstances[instanceName];
          if (!instance) return;

          // Only close Baileys connections gracefully
          if (instance.integration === Integration.WHATSAPP_BAILEYS) {
            await this.closeBaileysConnection(instanceName, instance);
          }

        } catch (error) {
          this.logger.error(`Failed to close connection for instance ${instanceName}: ${error?.toString()}`);
        }
      });

      await Promise.allSettled(closePromises);
      this.logger.info(`Attempted to close ${instances.length} connections`);

    } catch (error) {
      this.logger.error(`Failed to close connections: ${error?.toString()}`);
      throw error;
    }
  }

  private async closeBaileysConnection(instanceName: string, instance: any): Promise<void> {
    try {
      this.logger.debug(`Closing Baileys connection for instance: ${instanceName}`);

      // Set a timeout for connection closure
      const closeTimeout = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection close timeout')), 5000)
      );

      const closeConnection = async () => {
        if (instance.client?.ws) {
          // Update status to closing
          instance.stateConnection.state = 'close';

          // Close WebSocket gracefully
          if (instance.client.ws.readyState === 1) { // WebSocket.OPEN
            instance.client.ws.close(1000, 'Graceful shutdown');
          }

          // End the client
          if (instance.client.end) {
            instance.client.end(new Error('Graceful shutdown'));
          }
        }
      };

      await Promise.race([closeConnection(), closeTimeout]);
      this.logger.debug(`Successfully closed connection for instance: ${instanceName}`);

    } catch (error) {
      this.logger.warn(`Timeout or error closing connection for ${instanceName}: ${error.message}`);
      // Force close if graceful close fails
      if (instance.client?.ws) {
        instance.client.ws.terminate();
      }
    }
  }

  private async cleanupResources(): Promise<void> {
    try {
      this.logger.info('Cleaning up resources');

      // Clear all intervals and timeouts (if we had references to them)
      // This is a placeholder for any cleanup that might be needed

      // Give a moment for any pending operations to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      this.logger.info('Resource cleanup completed');

    } catch (error) {
      this.logger.error(`Failed to clean up resources: ${error?.toString()}`);
      throw error;
    }
  }

  /**
   * Check if the service is currently shutting down
   */
  public isInShutdown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Manual shutdown trigger (for programmatic shutdown)
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Manual shutdown triggered');
    await this.initiateShutdown();
  }
}