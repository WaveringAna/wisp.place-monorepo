/**
 * Firehose Service - Ingests AT Protocol firehose events and caches sites to S3
 *
 * Modes:
 * - Normal: Watch firehose for place.wisp.fs events
 * - Backfill: Process existing sites from database
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config';
import { startFirehose, stopFirehose, getFirehoseHealth } from './lib/firehose';
import { closeDatabase, listAllSiteCaches, getSiteCache } from './lib/db';
import { storage } from './lib/storage';
import { handleSiteCreateOrUpdate, fetchSiteRecord } from './lib/cache-writer';

const app = new Hono();

// Health endpoint
app.get('/health', async (c) => {
  const firehoseHealth = getFirehoseHealth();
  const storageStats = await storage.getStats();

  return c.json({
    status: firehoseHealth.healthy ? 'healthy' : 'degraded',
    mode: config.isBackfill ? 'backfill' : 'firehose',
    firehose: firehoseHealth,
    storage: storageStats,
  });
});

// Graceful shutdown
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Service] Received ${signal}, shutting down...`);

  stopFirehose();
  await closeDatabase();

  console.log('[Service] Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Backfill mode - process existing sites from database
 */
async function runBackfill(): Promise<void> {
  console.log('[Backfill] Starting backfill mode');

  const sites = await listAllSiteCaches();
  console.log(`[Backfill] Found ${sites.length} sites in database`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const site of sites) {
    try {
      // Fetch current record from PDS
      const result = await fetchSiteRecord(site.did, site.rkey);

      if (!result) {
        console.log(`[Backfill] Site not found on PDS: ${site.did}/${site.rkey}`);
        skipped++;
        continue;
      }

      // Check if CID matches (already up to date)
      if (result.cid === site.record_cid) {
        console.log(`[Backfill] Site already up to date: ${site.did}/${site.rkey}`);
        skipped++;
        continue;
      }

      // Process the site
      await handleSiteCreateOrUpdate(site.did, site.rkey, result.record, result.cid);
      processed++;

      console.log(`[Backfill] Progress: ${processed + skipped + failed}/${sites.length}`);
    } catch (err) {
      console.error(`[Backfill] Failed to process ${site.did}/${site.rkey}:`, err);
      failed++;
    }
  }

  console.log(`[Backfill] Complete: ${processed} processed, ${skipped} skipped, ${failed} failed`);
}

// Main entry point
async function main() {
  console.log('[Service] Starting firehose-service');
  console.log(`[Service] Mode: ${config.isBackfill ? 'backfill' : 'firehose'}`);
  console.log(`[Service] S3 Bucket: ${config.s3Bucket || '(disk fallback)'}`);

  // Start health server
  const server = serve({
    fetch: app.fetch,
    port: config.healthPort,
  });

  console.log(`[Service] Health endpoint: http://localhost:${config.healthPort}/health`);

  if (config.isBackfill) {
    // Run backfill and exit
    await runBackfill();
    await closeDatabase();
    process.exit(0);
  } else {
    // Start firehose
    startFirehose();
  }
}

main().catch((err) => {
  console.error('[Service] Fatal error:', err);
  process.exit(1);
});
