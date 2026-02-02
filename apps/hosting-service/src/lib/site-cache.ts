/**
 * Site caching management utilities
 */

import { createLogger } from '@wispplace/observability';
import { fetchSiteRecord, getPdsForDid, downloadAndCacheSite, isCached } from './utils';
import { markSiteAsBeingCached, unmarkSiteAsBeingCached, LRUCache } from './cache';
import type { RedirectRule } from './redirects';

const logger = createLogger('hosting-service');

// Cache for redirect rules (per site) - LRU with 1000 site limit
// Each entry is relatively small (array of redirect rules), so 1000 sites should be < 10MB
const redirectRulesCache = new LRUCache<RedirectRule[]>(10 * 1024 * 1024, 1000); // 10MB, 1000 sites

/**
 * Clear redirect rules cache for a specific site
 * Should be called when a site is updated/recached
 */
export function clearRedirectRulesCache(did: string, rkey: string) {
  const cacheKey = `${did}:${rkey}`;
  redirectRulesCache.delete(cacheKey);
}

/**
 * Get redirect rules from cache
 */
export function getRedirectRulesFromCache(did: string, rkey: string): RedirectRule[] | null {
  const cacheKey = `${did}:${rkey}`;
  return redirectRulesCache.get(cacheKey);
}

/**
 * Set redirect rules in cache
 */
export function setRedirectRulesInCache(did: string, rkey: string, rules: RedirectRule[]) {
  const cacheKey = `${did}:${rkey}`;
  // Estimate size: roughly 100 bytes per rule
  const estimatedSize = rules.length * 100;
  redirectRulesCache.set(cacheKey, rules, estimatedSize);
}

/**
 * Helper to ensure site is cached
 * Returns true if site is successfully cached, false otherwise
 */
export async function ensureSiteCached(did: string, rkey: string): Promise<boolean> {
  if (await isCached(did, rkey)) {
    console.log(`[Cache Hit] Site already cached - ${did}:${rkey}`);
    return true;
  }

  // Fetch and cache the site
  console.log(`[On-Demand] Caching site on first request - ${did}:${rkey}`);
  const siteData = await fetchSiteRecord(did, rkey);
  if (!siteData) {
    logger.error('Site record not found', null, { did, rkey });
    return false;
  }

  const pdsEndpoint = await getPdsForDid(did);
  if (!pdsEndpoint) {
    logger.error('PDS not found for DID', null, { did });
    return false;
  }

  // Mark site as being cached to prevent serving stale content during update
  markSiteAsBeingCached(did, rkey);

  try {
    await downloadAndCacheSite(did, rkey, siteData.record, pdsEndpoint, siteData.cid);
    // Clear redirect rules cache since the site was updated
    clearRedirectRulesCache(did, rkey);
    logger.info('Site cached successfully (on-demand)', { did, rkey });
    console.log(`[On-Demand] Successfully cached ${did}:${rkey}`);
    return true;
  } catch (err) {
    logger.error('Failed to cache site on-demand', err, { did, rkey });
    return false;
  } finally {
    // Always unmark, even if caching fails
    unmarkSiteAsBeingCached(did, rkey);
  }
}

