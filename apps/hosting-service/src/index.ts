import app from './server';
import { serve } from '@hono/node-server';
import { initializeGrafanaExporters, createLogger } from '@wispplace/observability';
import { mkdirSync, existsSync } from 'fs';
import { closeDatabase, CACHE_ONLY } from './lib/db';
import { cache } from './lib/cache-manager';
import { closeRevalidateQueue } from './lib/revalidate-queue';
import { startCacheInvalidationSubscriber, stopCacheInvalidationSubscriber } from './lib/cache-invalidation';
import { storage, getStorageConfig } from './lib/storage';

const logger = createLogger('hosting-service');

// Initialize Grafana exporters if configured
initializeGrafanaExporters({
  serviceName: 'hosting-service',
  serviceVersion: '1.0.0'
});

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const CACHE_DIR = process.env.CACHE_DIR || './cache/sites';

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
  logger.info('Created cache directory', { CACHE_DIR });
}

// Start in-memory cache cleanup
cache.startCleanup();

// Start cache invalidation subscriber (listens for firehose-service updates via Redis pub/sub)
startCacheInvalidationSubscriber();

// Optional: Bootstrap hot cache from warm tier on startup
const BOOTSTRAP_HOT_ON_STARTUP = process.env.BOOTSTRAP_HOT_ON_STARTUP === 'true';
const BOOTSTRAP_HOT_LIMIT = process.env.BOOTSTRAP_HOT_LIMIT ? parseInt(process.env.BOOTSTRAP_HOT_LIMIT) : 100;

if (BOOTSTRAP_HOT_ON_STARTUP) {
  logger.info(`Bootstrapping hot cache (top ${BOOTSTRAP_HOT_LIMIT} items)...`);
  storage.bootstrapHot(BOOTSTRAP_HOT_LIMIT)
    .then((loaded: number) => {
      logger.info(`Bootstrapped ${loaded} items into hot cache`);
    })
    .catch((err: unknown) => {
      logger.error('Hot cache bootstrap error', err);
    });
}

// Add health check endpoint
app.get('/health', async (c) => {
  const storageStats = await storage.getStats();

  return c.json({
    status: 'ok',
    storage: storageStats,
  });
});

// Start HTTP server with Node.js adapter
const server = serve({
  fetch: app.fetch,
  port: PORT,
});

// Get storage configuration for display
const storageConfig = getStorageConfig();

console.log(`
Wisp Hosting Service (Read-Only) with Tiered Storage

Server:       http://localhost:${PORT}
Health:       http://localhost:${PORT}/health

Mode:         ${CACHE_ONLY ? 'CACHE-ONLY (no DB writes)' : 'Standard (with DB writes)'}

Tiered Storage Configuration:
  Hot Cache:        ${storageConfig.hotCacheSize} (${storageConfig.hotCacheCount} items max)
  Warm Cache:       ${storageConfig.warmCacheSize} (${storageConfig.warmEvictionPolicy} eviction)
  Cold Storage:     S3 - ${storageConfig.s3Bucket}
  S3 Region:        ${storageConfig.s3Region}
  S3 Endpoint:      ${storageConfig.s3Endpoint}
  S3 Prefix:        ${storageConfig.s3Prefix}
  Metadata Bucket:  ${storageConfig.metadataBucket}

Firehose:     DISABLED (read-only)
`);

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  cache.stopCleanup();
  await stopCacheInvalidationSubscriber();
  await closeRevalidateQueue();
  await closeDatabase();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  cache.stopCleanup();
  await stopCacheInvalidationSubscriber();
  await closeRevalidateQueue();
  await closeDatabase();
  server.close();
  process.exit(0);
});
