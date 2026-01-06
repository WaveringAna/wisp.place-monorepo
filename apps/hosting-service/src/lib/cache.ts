/**
 * Cache management for wisp-hosting-service
 *
 * With tiered storage, most caching is handled transparently.
 * This module tracks sites being cached and manages rewritten HTML cache.
 */

import { storage } from './storage';

// In-memory LRU cache for rewritten HTML (for path rewriting in subdomain routes)
interface CacheEntry<T> {
  value: T;
  size: number;
  timestamp: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  currentSize: number;
  currentCount: number;
}

export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private maxSize: number;
  private maxCount: number;
  private currentSize: number;
  private stats: CacheStats;

  constructor(maxSize: number, maxCount: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.maxCount = maxCount;
    this.currentSize = 0;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      currentSize: 0,
      currentCount: 0,
    };
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.stats.hits++;
    return entry.value;
  }

  set(key: string, value: T, size: number): void {
    // Remove existing entry if present
    if (this.cache.has(key)) {
      const existing = this.cache.get(key)!;
      this.currentSize -= existing.size;
      this.cache.delete(key);
    }

    // Evict entries if needed
    while (
      (this.cache.size >= this.maxCount || this.currentSize + size > this.maxSize) &&
      this.cache.size > 0
    ) {
      const firstKey = this.cache.keys().next().value;
      if (!firstKey) break; // Should never happen, but satisfy TypeScript
      const firstEntry = this.cache.get(firstKey);
      if (!firstEntry) break; // Should never happen, but satisfy TypeScript
      this.cache.delete(firstKey);
      this.currentSize -= firstEntry.size;
      this.stats.evictions++;
    }

    // Add new entry
    this.cache.set(key, {
      value,
      size,
      timestamp: Date.now(),
    });
    this.currentSize += size;

    // Update stats
    this.stats.currentSize = this.currentSize;
    this.stats.currentCount = this.cache.size;
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.cache.delete(key);
    this.currentSize -= entry.size;
    this.stats.currentSize = this.currentSize;
    this.stats.currentCount = this.cache.size;
    return true;
  }

  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
    this.stats.currentSize = 0;
    this.stats.currentCount = 0;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 0 : (this.stats.hits / total) * 100;
  }
}

// Rewritten HTML cache: stores HTML after path rewriting for subdomain routes
export const rewrittenHtmlCache = new LRUCache<Buffer>(50 * 1024 * 1024, 200); // 50MB for rewritten HTML

// Helper to generate cache keys for rewritten HTML
export function getCacheKey(did: string, rkey: string, filePath: string, suffix?: string): string {
  const base = `${did}:${rkey}:${filePath}`;
  return suffix ? `${base}:${suffix}` : base;
}

/**
 * Invalidate site cache via tiered storage
 * Also invalidates locally cached rewritten HTML
 */
export async function invalidateSiteCache(did: string, rkey: string): Promise<void> {
  // Invalidate in tiered storage
  const prefix = `${did}/${rkey}/`;
  const deleted = await storage.invalidate(prefix);

  // Invalidate rewritten HTML cache for this site
  const sitePrefix = `${did}:${rkey}:`;
  let htmlCount = 0;
  const cacheKeys = Array.from((rewrittenHtmlCache as any).cache?.keys() || []) as string[];
  for (const key of cacheKeys) {
    if (key.startsWith(sitePrefix)) {
      rewrittenHtmlCache.delete(key);
      htmlCount++;
    }
  }

  console.log(`[Cache] Invalidated site ${did}:${rkey} - ${deleted} files in tiered storage, ${htmlCount} rewritten HTML`);
}

// Track sites currently being cached (to prevent serving stale cache during updates)
const sitesBeingCached = new Set<string>();

export function markSiteAsBeingCached(did: string, rkey: string): void {
  const key = `${did}:${rkey}`;
  sitesBeingCached.add(key);
}

export function unmarkSiteAsBeingCached(did: string, rkey: string): void {
  const key = `${did}:${rkey}`;
  sitesBeingCached.delete(key);
}

export function isSiteBeingCached(did: string, rkey: string): boolean {
  const key = `${did}:${rkey}`;
  return sitesBeingCached.has(key);
}

// Get overall cache statistics
export async function getCacheStats() {
  const tieredStats = await storage.getStats();

  return {
    tieredStorage: tieredStats,
    rewrittenHtml: rewrittenHtmlCache.getStats(),
    rewrittenHtmlHitRate: rewrittenHtmlCache.getHitRate(),
    sitesBeingCached: sitesBeingCached.size,
  };
}
