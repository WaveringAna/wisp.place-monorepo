/**
 * Redirect rules cache utilities
 */

import { LRUCache } from './cache';
import type { RedirectRule } from './redirects';

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
