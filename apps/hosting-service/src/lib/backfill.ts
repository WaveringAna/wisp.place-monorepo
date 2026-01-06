import { getAllSites } from './db';
import { fetchSiteRecord, getPdsForDid, downloadAndCacheSite, isCached } from './utils';
import { createLogger } from '@wisp/observability';
import { markSiteAsBeingCached, unmarkSiteAsBeingCached } from './cache';
import { clearRedirectRulesCache } from './site-cache';

const logger = createLogger('hosting-service');

export interface BackfillOptions {
  skipExisting?: boolean; // Skip sites already in cache
  concurrency?: number; // Number of sites to cache concurrently
  maxSites?: number; // Maximum number of sites to backfill (for testing)
}

export interface BackfillStats {
  total: number;
  cached: number;
  skipped: number;
  failed: number;
  duration: number;
}

/**
 * Backfill all sites from the database into the local cache
 */
export async function backfillCache(options: BackfillOptions = {}): Promise<BackfillStats> {
  const {
    skipExisting = true,
    concurrency = 10, // Increased from 3 to 10 for better parallelization
    maxSites,
  } = options;

  const startTime = Date.now();
  const stats: BackfillStats = {
    total: 0,
    cached: 0,
    skipped: 0,
    failed: 0,
    duration: 0,
  };

  logger.info('Starting cache backfill', { skipExisting, concurrency, maxSites });
  console.log(`
╔══════════════════════════════════════════╗
║     CACHE BACKFILL STARTING              ║
╚══════════════════════════════════════════╝
  `);

  try {
    // Get all sites from database
    let sites = await getAllSites();
    stats.total = sites.length;

    logger.info(`Found ${sites.length} sites in database`);
    console.log(`📊 Found ${sites.length} sites in database`);

    // Limit if specified
    if (maxSites && maxSites > 0) {
      sites = sites.slice(0, maxSites);
      console.log(`⚙️  Limited to ${maxSites} sites for backfill`);
    }

    // Process sites with sliding window concurrency pool
    const executing = new Set<Promise<void>>();
    let processed = 0;

    for (const site of sites) {
      // Create task for this site
      const processSite = async () => {
        try {
          // Check if already cached
          if (skipExisting && await isCached(site.did, site.rkey)) {
            stats.skipped++;
            processed++;
            logger.debug(`Skipping already cached site`, { did: site.did, rkey: site.rkey });
            console.log(`⏭️  [${processed}/${sites.length}] Skipped (cached): ${site.display_name || site.rkey}`);
            return;
          }

          // Fetch site record
          const siteData = await fetchSiteRecord(site.did, site.rkey);
          if (!siteData) {
            stats.failed++;
            processed++;
            logger.error('Site record not found during backfill', null, { did: site.did, rkey: site.rkey });
            console.log(`❌ [${processed}/${sites.length}] Failed (not found): ${site.display_name || site.rkey}`);
            return;
          }

          // Get PDS endpoint
          const pdsEndpoint = await getPdsForDid(site.did);
          if (!pdsEndpoint) {
            stats.failed++;
            processed++;
            logger.error('PDS not found during backfill', null, { did: site.did });
            console.log(`❌ [${processed}/${sites.length}] Failed (no PDS): ${site.display_name || site.rkey}`);
            return;
          }

          // Mark site as being cached to prevent serving stale content during update
          markSiteAsBeingCached(site.did, site.rkey);

          try {
            // Download and cache site
            await downloadAndCacheSite(site.did, site.rkey, siteData.record, pdsEndpoint, siteData.cid);
            // Clear redirect rules cache since the site was updated
            clearRedirectRulesCache(site.did, site.rkey);
            stats.cached++;
            processed++;
            logger.info('Successfully cached site during backfill', { did: site.did, rkey: site.rkey });
            console.log(`✅ [${processed}/${sites.length}] Cached: ${site.display_name || site.rkey}`);
          } finally {
            // Always unmark, even if caching fails
            unmarkSiteAsBeingCached(site.did, site.rkey);
          }
        } catch (err) {
          stats.failed++;
          processed++;
          logger.error('Failed to cache site during backfill', err, { did: site.did, rkey: site.rkey });
          console.log(`❌ [${processed}/${sites.length}] Failed: ${site.display_name || site.rkey}`);
        }
      };

      // Add to executing pool and remove when done
      const promise = processSite().finally(() => executing.delete(promise));
      executing.add(promise);

      // When pool is full, wait for at least one to complete
      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    // Wait for all remaining tasks to complete
    await Promise.all(executing);

    stats.duration = Date.now() - startTime;

    console.log(`
╔══════════════════════════════════════════╗
║     CACHE BACKFILL COMPLETED             ║
╚══════════════════════════════════════════╝

📊 Total Sites:    ${stats.total}
✅ Cached:         ${stats.cached}
⏭️  Skipped:        ${stats.skipped}
❌ Failed:         ${stats.failed}
⏱️  Duration:       ${(stats.duration / 1000).toFixed(2)}s
    `);

    logger.info('Cache backfill completed', stats);
  } catch (err) {
    logger.error('Cache backfill failed', err);
    console.error('❌ Cache backfill failed:', err);
  }

  return stats;
}
