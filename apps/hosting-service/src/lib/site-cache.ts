/**
 * Site caching management utilities
 */

import { createLogger } from '@wisp/observability';
import { fetchSiteRecord, getPdsForDid, downloadAndCacheSite, isCached } from './utils';
import { markSiteAsBeingCached, unmarkSiteAsBeingCached } from './cache';
import type { RedirectRule } from './redirects';

const logger = createLogger('hosting-service');

// Cache for redirect rules (per site)
const redirectRulesCache = new Map<string, RedirectRule[]>();

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
export function getRedirectRulesFromCache(did: string, rkey: string): RedirectRule[] | undefined {
  const cacheKey = `${did}:${rkey}`;
  return redirectRulesCache.get(cacheKey);
}

/**
 * Set redirect rules in cache
 */
export function setRedirectRulesInCache(did: string, rkey: string, rules: RedirectRule[]) {
  const cacheKey = `${did}:${rkey}`;
  redirectRulesCache.set(cacheKey, rules);
}

/**
 * Helper to ensure site is cached
 * Returns true if site is successfully cached, false otherwise
 */
export async function ensureSiteCached(did: string, rkey: string): Promise<boolean> {
  if (isCached(did, rkey)) {
    return true;
  }

  // Fetch and cache the site
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
    logger.info('Site cached successfully', { did, rkey });
    return true;
  } catch (err) {
    logger.error('Failed to cache site', err, { did, rkey });
    return false;
  } finally {
    // Always unmark, even if caching fails
    unmarkSiteAsBeingCached(did, rkey);
  }
}

