import app from './server';
import { serve } from '@hono/node-server';
import { FirehoseWorker } from './lib/firehose';
import { createLogger, initializeGrafanaExporters } from '@wispplace/observability';
import { mkdirSync, existsSync } from 'fs';
import { backfillCache } from './lib/backfill';
import { startDomainCacheCleanup, stopDomainCacheCleanup, setCacheOnlyMode, closeDatabase } from './lib/db';
import { storage, getStorageConfig } from './lib/storage';

// Initialize Grafana exporters if configured
initializeGrafanaExporters({
  serviceName: 'hosting-service',
  serviceVersion: '1.0.0'
});

const logger = createLogger('hosting-service');

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const CACHE_DIR = process.env.CACHE_DIR || './cache/sites';
const BACKFILL_CONCURRENCY = process.env.BACKFILL_CONCURRENCY
  ? parseInt(process.env.BACKFILL_CONCURRENCY)
  : undefined; // Let backfill.ts default (10) apply

// Parse CLI arguments
const args = process.argv.slice(2);
const hasBackfillFlag = args.includes('--backfill');
const backfillOnStartup = hasBackfillFlag || process.env.BACKFILL_ON_STARTUP === 'true';

// Cache-only mode: service will only cache files locally, no DB writes
const hasCacheOnlyFlag = args.includes('--cache-only');
export const CACHE_ONLY_MODE = hasCacheOnlyFlag || process.env.CACHE_ONLY_MODE === 'true';

// Configure cache-only mode in database module
if (CACHE_ONLY_MODE) {
  setCacheOnlyMode(true);
}

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log('Created cache directory:', CACHE_DIR);
}

// Start domain cache cleanup
startDomainCacheCleanup();

// Start firehose worker with observability logger
const firehose = new FirehoseWorker((msg, data) => {
  logger.info(msg, data);
});

firehose.start();

// Optional: Bootstrap hot cache from warm tier on startup
const BOOTSTRAP_HOT_ON_STARTUP = process.env.BOOTSTRAP_HOT_ON_STARTUP === 'true';
const BOOTSTRAP_HOT_LIMIT = process.env.BOOTSTRAP_HOT_LIMIT ? parseInt(process.env.BOOTSTRAP_HOT_LIMIT) : 100;

if (BOOTSTRAP_HOT_ON_STARTUP) {
  console.log(`🔥 Bootstrapping hot cache (top ${BOOTSTRAP_HOT_LIMIT} items)...`);
  storage.bootstrapHot(BOOTSTRAP_HOT_LIMIT)
    .then((loaded: number) => {
      console.log(`✅ Bootstrapped ${loaded} items into hot cache`);
    })
    .catch((err: unknown) => {
      console.error('❌ Hot cache bootstrap error:', err);
    });
}

// Run backfill if requested
if (backfillOnStartup) {
  console.log('🔄 Backfill requested, starting cache backfill...');
  backfillCache({
    skipExisting: true,
    concurrency: BACKFILL_CONCURRENCY,
  }).then((stats) => {
    console.log('✅ Cache backfill completed');
  }).catch((err) => {
    console.error('❌ Cache backfill error:', err);
  });
}

// Add health check endpoint
app.get('/health', async (c) => {
  const firehoseHealth = firehose.getHealth();
  const storageStats = await storage.getStats();

  return c.json({
    status: 'ok',
    firehose: firehoseHealth,
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
Wisp Hosting Service with Tiered Storage

Server:       http://localhost:${PORT}
Health:       http://localhost:${PORT}/health
Cache-Only:   ${CACHE_ONLY_MODE ? 'ENABLED (no DB writes)' : 'DISABLED'}
Backfill:     ${backfillOnStartup ? `ENABLED (concurrency: ${BACKFILL_CONCURRENCY || 10})` : 'DISABLED'}

Tiered Storage Configuration:
  Hot Cache:        ${storageConfig.hotCacheSize} (${storageConfig.hotCacheCount} items max)
  Warm Cache:       ${storageConfig.warmCacheSize} (${storageConfig.warmEvictionPolicy} eviction)
  Cold Storage:     S3 - ${storageConfig.s3Bucket}
  S3 Region:        ${storageConfig.s3Region}
  S3 Endpoint:      ${storageConfig.s3Endpoint}
  S3 Prefix:        ${storageConfig.s3Prefix}
  Metadata Bucket:  ${storageConfig.metadataBucket}

Firehose:     Connecting...
`);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await firehose.stop();
  stopDomainCacheCleanup();
  await closeDatabase();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  await firehose.stop();
  stopDomainCacheCleanup();
  await closeDatabase();
  server.close();
  process.exit(0);
});
