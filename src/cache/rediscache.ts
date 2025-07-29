import { ICache } from '@api/abstract/abstract.cache';
import { CacheConf, CacheConfRedis, ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BufferJSON } from 'baileys';
import { RedisClientType } from 'redis';

import { redisClient } from './rediscache.client';

export class RedisCache implements ICache {
  private readonly logger = new Logger('RedisCache');
  private client: RedisClientType;
  private conf: CacheConfRedis;

  constructor(
    private readonly configService: ConfigService,
    private readonly module: string,
  ) {
    this.conf = this.configService.get<CacheConf>('CACHE')?.REDIS;
    this.client = redisClient.getConnection();
  }
  async get(key: string): Promise<any> {
    try {
      const fullKey = this.buildKey(key);
      const result = await this.client.get(fullKey);
      return result ? JSON.parse(result) : null;
    } catch (error) {
      // Handle WRONGTYPE errors by attempting to detect and fix key type issues
      if (error.message && error.message.includes('WRONGTYPE')) {
        this.logger.warn(`WRONGTYPE error for key ${key}, attempting to resolve...`);
        return await this.handleWrongTypeError(key, 'get');
      }
      this.logger.error(`Redis get error for key ${key}:`, error);
      return null;
    }
  }

  async hGet(key: string, field: string) {
    try {
      const fullKey = this.buildKey(key);
      const data = await this.client.hGet(fullKey, field);

      if (data) {
        return JSON.parse(data, BufferJSON.reviver);
      }

      return null;
    } catch (error) {
      // Handle WRONGTYPE errors by attempting to detect and fix key type issues
      if (error.message && error.message.includes('WRONGTYPE')) {
        this.logger.warn(`WRONGTYPE error for hash key ${key}:${field}, attempting to resolve...`);
        return await this.handleWrongTypeError(key, 'hGet', field);
      }
      this.logger.error(`Redis hGet error for key ${key}:${field}:`, error);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number) {
    try {
      const fullKey = this.buildKey(key);
      const serializedValue = JSON.stringify(value);
      
      if (ttl === 0) {
        // No expiration
        await this.client.set(fullKey, serializedValue);
      } else {
        await this.client.setEx(fullKey, ttl || this.conf?.TTL, serializedValue);
      }
      
      this.logger.verbose(`Redis set successful for key: ${key}`);
    } catch (error) {
      // Handle WRONGTYPE errors by attempting to detect and fix key type issues
      if (error.message && error.message.includes('WRONGTYPE')) {
        this.logger.warn(`WRONGTYPE error for key ${key}, attempting to resolve...`);
        return await this.handleWrongTypeError(key, 'set', undefined, value, ttl);
      }
      this.logger.error(`Redis set error for key ${key}:`, error);
      throw error;
    }
  }

  async hSet(key: string, field: string, value: any) {
    try {
      const fullKey = this.buildKey(key);
      const json = JSON.stringify(value, BufferJSON.replacer);

      await this.client.hSet(fullKey, field, json);
      this.logger.verbose(`Redis hSet successful for key: ${key}:${field}`);
    } catch (error) {
      // Handle WRONGTYPE errors by attempting to detect and fix key type issues
      if (error.message && error.message.includes('WRONGTYPE')) {
        this.logger.warn(`WRONGTYPE error for hash key ${key}:${field}, attempting to resolve...`);
        return await this.handleWrongTypeError(key, 'hSet', field, value);
      }
      this.logger.error(`Redis hSet error for key ${key}:${field}:`, error);
      throw error;
    }
  }

  async has(key: string) {
    try {
      return (await this.client.exists(this.buildKey(key))) > 0;
    } catch (error) {
      this.logger.error(error);
    }
  }

  async delete(key: string) {
    try {
      return await this.client.del(this.buildKey(key));
    } catch (error) {
      this.logger.error(error);
    }
  }

  async hDelete(key: string, field: string) {
    try {
      return await this.client.hDel(this.buildKey(key), field);
    } catch (error) {
      this.logger.error(error);
    }
  }

  async deleteAll(appendCriteria?: string) {
    try {
      const keys = await this.keys(appendCriteria);
      if (!keys?.length) {
        return 0;
      }

      return await this.client.del(keys);
    } catch (error) {
      this.logger.error(error);
    }
  }

  async keys(appendCriteria?: string) {
    try {
      const match = `${this.buildKey('')}${appendCriteria ? `${appendCriteria}:` : ''}*`;
      const keys = [];
      for await (const key of this.client.scanIterator({
        MATCH: match,
        COUNT: 100,
      })) {
        keys.push(key);
      }

      return [...new Set(keys)];
    } catch (error) {
      this.logger.error(error);
    }
  }

  buildKey(key: string) {
    return `${this.conf?.PREFIX_KEY}:${this.module}:${key}`;
  }

  /**
   * Handle WRONGTYPE errors by detecting key type and attempting recovery
   */
  private async handleWrongTypeError(key: string, operation: string, field?: string, value?: any, ttl?: number): Promise<any> {
    try {
      const fullKey = this.buildKey(key);
      
      // Check the current type of the key
      const keyType = await this.client.type(fullKey);
      this.logger.info(`Key ${key} has type: ${keyType}, operation: ${operation}`);
      
      // If the key exists but has wrong type, delete it and retry
      if (keyType !== 'none') {
        this.logger.warn(`Deleting corrupted key ${key} with type ${keyType} to resolve WRONGTYPE error`);
        await this.client.del(fullKey);
        
        // Retry the original operation after cleanup
        switch (operation) {
          case 'get':
            return null; // Key was corrupted, return null
          case 'hGet':
            return null; // Key was corrupted, return null
          case 'set':
            if (value !== undefined) {
              const serializedValue = JSON.stringify(value);
              if (ttl === 0) {
                await this.client.set(fullKey, serializedValue);
              } else {
                await this.client.setEx(fullKey, ttl || this.conf?.TTL, serializedValue);
              }
              this.logger.info(`Successfully recreated string key ${key} after WRONGTYPE cleanup`);
            }
            break;
          case 'hSet':
            if (value !== undefined && field !== undefined) {
              const json = JSON.stringify(value, BufferJSON.replacer);
              await this.client.hSet(fullKey, field, json);
              this.logger.info(`Successfully recreated hash key ${key}:${field} after WRONGTYPE cleanup`);
            }
            break;
        }
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Failed to handle WRONGTYPE error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Check if a key exists and return its type
   */
  async getKeyType(key: string): Promise<string> {
    try {
      const fullKey = this.buildKey(key);
      return await this.client.type(fullKey);
    } catch (error) {
      this.logger.error(`Error checking key type for ${key}:`, error);
      return 'none';
    }
  }

  /**
   * Clean up corrupted keys that have wrong types
   */
  async cleanupCorruptedKeys(pattern?: string): Promise<number> {
    try {
      const searchPattern = pattern || `${this.buildKey('')}*`;
      let cleanedCount = 0;
      
      for await (const key of this.client.scanIterator({
        MATCH: searchPattern,
        COUNT: 100,
      })) {
        try {
          const keyType = await this.client.type(key);
          
          // Extract the logical key name for validation
          const logicalKey = key.replace(`${this.conf?.PREFIX_KEY}:${this.module}:`, '');
          
          // Define expected types for different key patterns
          const shouldBeHash = logicalKey.includes(':') || logicalKey.includes('-'); // Auth state keys typically have separators
          const shouldBeString = !shouldBeHash; // Instance data keys are typically simple strings
          
          if ((shouldBeHash && keyType !== 'hash') || (shouldBeString && keyType !== 'string' && keyType !== 'none')) {
            this.logger.warn(`Found corrupted key ${logicalKey} with type ${keyType}, expected ${shouldBeHash ? 'hash' : 'string'}`);
            await this.client.del(key);
            cleanedCount++;
          }
        } catch (error) {
          this.logger.error(`Error processing key ${key} during cleanup:`, error);
        }
      }
      
      this.logger.info(`Cleaned up ${cleanedCount} corrupted Redis keys`);
      return cleanedCount;
    } catch (error) {
      this.logger.error('Error during Redis key cleanup:', error);
      return 0;
    }
  }
}
