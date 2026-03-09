import { RedisClient } from 'bun';
import { createLogger } from '@wispplace/observability';

const logger = createLogger('main-app:redis');

let client: RedisClient | null = null;

/** Returns the shared Redis client, creating it lazily. Returns null if REDIS_URL is not set. */
export function getRedisClient(): RedisClient | null {
  const redisUrl = Bun.env.REDIS_URL;
  if (!redisUrl) return null;

  if (!client) {
    logger.info(`[Redis] Connecting to ${redisUrl}`);
    client = new RedisClient(redisUrl);
    client.onconnect = () => logger.info('[Redis] Connected');
    client.onclose = (err) => {
      if (err) logger.error('[Redis] Disconnected with error', err);
    };
  }

  return client;
}

export function closeRedisClient(): void {
  client?.close();
  client = null;
}
