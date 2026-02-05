import app from './server';
import { serve } from '@hono/node-server';
import { initializeGrafanaExporters } from '@wispplace/observability';
import { mkdirSync, existsSync } from 'fs';
import { startDomainCacheCleanup, stopDomainCacheCleanup, closeDatabase } from './lib/db';
import { closeRevalidateQueue } from './lib/revalidate-queue';
import { storage, getStorageConfig } from './lib/storage';

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
  console.log('Created cache directory:', CACHE_DIR);
}

// Start domain cache cleanup
startDomainCacheCleanup();

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
  console.log('\n🛑 Shutting down...');
  stopDomainCacheCleanup();
  await closeRevalidateQueue();
  await closeDatabase();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  stopDomainCacheCleanup();
  await closeRevalidateQueue();
  await closeDatabase();
  server.close();
  process.exit(0);
});
