import { CacheService } from '@api/services/cache.service';
import { Logger } from '@config/logger.config';
import { AuthenticationCreds, AuthenticationState, initAuthCreds, proto, SignalDataTypeMap } from 'baileys';

export async function useMultiFileAuthStateRedisDb(
  instanceName: string,
  cache: CacheService,
): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  const logger = new Logger('useMultiFileAuthStateRedisDb');

  const writeData = async (data: any, key: string): Promise<any> => {
    try {
      // Use a separate namespace for auth state to avoid conflicts with instance data
      const authKey = `auth:${instanceName}`;
      logger.verbose(`Writing auth data for ${authKey}:${key}`);
      return await cache.hSet(authKey, key, data);
    } catch (error) {
      logger.error({ localError: 'writeData', error, key, instanceName });

      // If Redis fails, log the error but don't crash the authentication process
      // The system should continue to work with in-memory auth state
      logger.warn(`Auth state write failed for ${instanceName}:${key}, continuing with in-memory state`);
      return null;
    }
  };

  const readData = async (key: string): Promise<any> => {
    try {
      // Use a separate namespace for auth state to avoid conflicts with instance data
      const authKey = `auth:${instanceName}`;
      logger.verbose(`Reading auth data for ${authKey}:${key}`);
      return await cache.hGet(authKey, key);
    } catch (error) {
      logger.error({ localError: 'readData', error, key, instanceName });

      // If reading fails due to Redis issues, return null to trigger fresh auth
      logger.warn(`Auth state read failed for ${instanceName}:${key}, will use fresh auth state`);
      return null;
    }
  };

  const removeData = async (key: string) => {
    try {
      // Use a separate namespace for auth state to avoid conflicts with instance data
      const authKey = `auth:${instanceName}`;
      logger.verbose(`Removing auth data for ${authKey}:${key}`);
      return await cache.hDelete(authKey, key);
    } catch (error) {
      logger.error({ localError: 'removeData', error, key, instanceName });

      // If removal fails, log but continue - this is not critical
      logger.warn(`Auth state removal failed for ${instanceName}:${key}, continuing`);
      return null;
    }
  };

  let creds: AuthenticationCreds;

  try {
    // Attempt to load credentials from Redis
    const storedCreds = await readData('creds');
    creds = storedCreds || initAuthCreds();

    if (storedCreds) {
      logger.info(`Loaded existing auth credentials for instance ${instanceName}`);
    } else {
      logger.info(`No existing auth credentials found for instance ${instanceName}, using fresh credentials`);
    }
  } catch (error) {
    logger.error(`Failed to load auth credentials for ${instanceName}: ${error?.toString()}`);
    logger.warn(`Falling back to fresh auth credentials for ${instanceName}`);
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids: string[]) => {
          try {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            const data: { [_: string]: SignalDataTypeMap[type] } = {};
            await Promise.all(
              ids.map(async (id) => {
                try {
                  let value = await readData(`${type}-${id}`);
                  if (type === 'app-state-sync-key' && value) {
                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                  }

                  data[id] = value;
                } catch (error) {
                  logger.error(`Failed to read key data for ${type}-${id}: ${error?.toString()}`);
                  // Continue with null value rather than failing completely
                  data[id] = null;
                }
              }),
            );

            return data;
          } catch (error) {
            logger.error(`Failed to get keys for type ${type}: ${error?.toString()}`);
            // Return empty object to allow auth to continue with fresh state
            return {};
          }
        },
        set: async (data: any) => {
          try {
            const tasks: Promise<void>[] = [];
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const key = `${category}-${id}`;
                tasks.push(value ? await writeData(value, key) : await removeData(key));
              }
            }

            await Promise.all(tasks);
            logger.verbose(`Successfully saved auth keys for instance ${instanceName}`);
          } catch (error) {
            logger.error(`Failed to set auth keys for instance ${instanceName}: ${error?.toString()}`);
            // Don't throw here - allow the auth process to continue even if Redis save fails
            logger.warn(`Auth key saving failed for ${instanceName}, session may not persist across restarts`);
          }
        },
      },
    },
    saveCreds: async () => {
      try {
        const result = await writeData(creds, 'creds');
        logger.verbose(`Successfully saved credentials for instance ${instanceName}`);
        return result;
      } catch (error) {
        logger.error(`Failed to save credentials for instance ${instanceName}: ${error?.toString()}`);
        // Don't throw here - allow the auth process to continue even if Redis save fails
        logger.warn(`Credential saving failed for ${instanceName}, session may not persist across restarts`);
      }
    },
  };
}
