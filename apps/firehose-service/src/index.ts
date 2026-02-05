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
import { closeDatabase, listAllSiteCaches, listAllSites, getSiteCache } from './lib/db';
import { storage } from './lib/storage';
import { handleSiteCreateOrUpdate, fetchSiteRecord } from './lib/cache-writer';
import { startRevalidateWorker, stopRevalidateWorker } from './lib/revalidate-worker';

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
  await stopRevalidateWorker();
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
  const startTime = Date.now();
  const forceRewriteHtml = process.env.BACKFILL_FORCE_REWRITE_HTML === 'true';

  if (forceRewriteHtml) {
    console.log('[Backfill] Forcing HTML rewrite for all sites');
  }

  let sites = await listAllSites();
  if (sites.length === 0) {
    const cachedSites = await listAllSiteCaches();
    sites = cachedSites.map(site => ({ did: site.did, rkey: site.rkey }));
    console.log('[Backfill] Sites table empty; falling back to site_cache entries');
  }

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

      const existingCache = await getSiteCache(site.did, site.rkey);
      // Check if CID matches (already up to date)
      if (!forceRewriteHtml && existingCache && result.cid === existingCache.record_cid) {
        console.log(`[Backfill] Site already up to date: ${site.did}/${site.rkey}`);
        skipped++;
        continue;
      }

      // Process the site
      await handleSiteCreateOrUpdate(site.did, site.rkey, result.record, result.cid, {
        forceRewriteHtml,
      });
      processed++;

      console.log(`[Backfill] Progress: ${processed + skipped + failed}/${sites.length}`);
    } catch (err) {
      console.error(`[Backfill] Failed to process ${site.did}/${site.rkey}:`, err);
      failed++;
    }
  }

  const elapsedMs = Date.now() - startTime;
  const elapsedSec = Math.round(elapsedMs / 1000);
  const elapsedMin = Math.floor(elapsedSec / 60);
  const elapsedRemSec = elapsedSec % 60;
  const elapsedLabel = elapsedMin > 0 ? `${elapsedMin}m ${elapsedRemSec}s` : `${elapsedSec}s`;

  console.log(`[Backfill] Complete: ${processed} processed, ${skipped} skipped, ${failed} failed (${elapsedLabel} elapsed)`);
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
    await startRevalidateWorker();
  }
}

main().catch((err) => {
  console.error('[Service] Fatal error:', err);
  process.exit(1);
});
