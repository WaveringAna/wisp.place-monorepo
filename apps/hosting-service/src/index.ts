import app from './server';
import { serve } from '@hono/node-server';
import { FirehoseWorker } from './lib/firehose';
import { createLogger, initializeGrafanaExporters } from '@wisp/observability';
import { mkdirSync, existsSync } from 'fs';
import { backfillCache } from './lib/backfill';
import { startDomainCacheCleanup, stopDomainCacheCleanup, setCacheOnlyMode } from './lib/db';

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
app.get('/health', (c) => {
  const firehoseHealth = firehose.getHealth();
  return c.json({
    status: 'ok',
    firehose: firehoseHealth,
  });
});

// Start HTTP server with Node.js adapter
const server = serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`
Wisp Hosting Service

Server:       http://localhost:${PORT}
Health:       http://localhost:${PORT}/health
Cache:        ${CACHE_DIR}
Firehose:     Connected to Firehose
Cache-Only:   ${CACHE_ONLY_MODE ? 'ENABLED (no DB writes)' : 'DISABLED'}
Backfill:     ${backfillOnStartup ? `ENABLED (concurrency: ${BACKFILL_CONCURRENCY || 10})` : 'DISABLED'}
`);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  firehose.stop();
  stopDomainCacheCleanup();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  firehose.stop();
  stopDomainCacheCleanup();
  server.close();
  process.exit(0);
});
