import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';

export class ConfigValidationService {
  private readonly logger = new Logger('ConfigValidationService');

  constructor(private readonly configService: ConfigService) {}

  /**
   * Validate all critical configuration settings for connection management
   */
  public validateConnectionConfig(): void {
    this.logger.info('Starting configuration validation for connection management');

    const issues: string[] = [];

    // Validate DATABASE settings
    this.validateDatabaseConfig(issues);

    // Validate CACHE settings
    this.validateCacheConfig(issues);

    // Validate DEL_INSTANCE setting
    this.validateDelInstanceConfig(issues);

    // Validate CLIENT_NAME setting
    this.validateClientNameConfig(issues);

    // Report findings
    if (issues.length > 0) {
      this.logger.warn('Configuration issues detected:');
      issues.forEach((issue) => this.logger.warn(`- ${issue}`));
      this.logger.warn('These issues may affect connection persistence and recovery');
    } else {
      this.logger.info('Configuration validation passed');
    }
  }

  private validateDatabaseConfig(issues: string[]): void {
    const db = this.configService.get('DATABASE');

    if (!db.SAVE_DATA.INSTANCE) {
      issues.push('DATABASE_SAVE_DATA_INSTANCE is disabled - instances will not persist after restart');
    }

    if (!db.CONNECTION.URI) {
      issues.push('DATABASE_CONNECTION_URI is not set - database operations will fail');
    }

    if (!db.CONNECTION.CLIENT_NAME || db.CONNECTION.CLIENT_NAME === 'evolution') {
      issues.push(
        'DATABASE_CONNECTION_CLIENT_NAME is using default value - may cause conflicts in multi-tenant environments',
      );
    }
  }

  private validateCacheConfig(issues: string[]): void {
    const cache = this.configService.get('CACHE');

    if (cache.REDIS.ENABLED) {
      if (!cache.REDIS.URI) {
        issues.push('CACHE_REDIS_ENABLED is true but CACHE_REDIS_URI is not set');
      }

      if (!cache.REDIS.SAVE_INSTANCES) {
        issues.push('CACHE_REDIS_SAVE_INSTANCES is disabled - Redis will not be used for instance persistence');
      }

      if (!cache.REDIS.PREFIX_KEY || cache.REDIS.PREFIX_KEY === 'evolution-cache') {
        issues.push('CACHE_REDIS_PREFIX_KEY is using default value - may cause conflicts in shared Redis environments');
      }
    } else {
      issues.push('Redis cache is disabled - connection state persistence will rely solely on database');
    }
  }

  private validateDelInstanceConfig(issues: string[]): void {
    const delInstance = this.configService.get('DEL_INSTANCE');

    if (delInstance === false) {
      this.logger.info('DEL_INSTANCE is disabled - instances will never be auto-removed');
    } else if (typeof delInstance === 'number') {
      if (delInstance < 5) {
        issues.push(
          `DEL_INSTANCE is set to ${delInstance} minutes - this may be too aggressive for connection recovery`,
        );
      }
      if (delInstance > 60) {
        this.logger.warn(
          `DEL_INSTANCE is set to ${delInstance} minutes - disconnected instances will persist for a long time`,
        );
      }
    }
  }

  private validateClientNameConfig(issues: string[]): void {
    const clientName = this.configService.get('DATABASE').CONNECTION.CLIENT_NAME;

    if (!clientName) {
      issues.push('DATABASE_CONNECTION_CLIENT_NAME is not set - instance filtering may not work correctly');
    } else if (clientName.length < 3) {
      issues.push('DATABASE_CONNECTION_CLIENT_NAME is too short - may cause identification issues');
    }
  }

  /**
   * Get recommended configuration for optimal connection management
   */
  public getRecommendedConfig(): Record<string, any> {
    return {
      DATABASE_SAVE_DATA_INSTANCE: 'true',
      CACHE_REDIS_ENABLED: 'true',
      CACHE_REDIS_SAVE_INSTANCES: 'true',
      CACHE_REDIS_TTL: '604800', // 1 week
      DEL_INSTANCE: '15', // 15 minutes
      QRCODE_LIMIT: '5',
      LOG_LEVEL: 'ERROR,WARN,DEBUG,INFO,LOG,VERBOSE,WEBHOOKS,WEBSOCKET',
      WEBSOCKET_ENABLED: 'true',
      DATABASE_CONNECTION_CLIENT_NAME: 'evolution_prod', // or environment-specific name
      CACHE_REDIS_PREFIX_KEY: 'evolution_prod', // or environment-specific prefix
    };
  }

  /**
   * Check if the current configuration is optimized for connection reliability
   */
  public isOptimalConfig(): boolean {
    const db = this.configService.get('DATABASE');
    const cache = this.configService.get('CACHE');

    return (
      db.SAVE_DATA.INSTANCE &&
      cache.REDIS.ENABLED &&
      cache.REDIS.SAVE_INSTANCES &&
      db.CONNECTION.CLIENT_NAME &&
      db.CONNECTION.CLIENT_NAME !== 'evolution'
    );
  }
}
