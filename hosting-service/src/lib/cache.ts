// In-memory LRU cache for file contents and metadata

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

  // Invalidate all entries for a specific site
  invalidateSite(did: string, rkey: string): number {
    const prefix = `${did}:${rkey}:`;
    let count = 0;

    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) {
        this.delete(key);
        count++;
      }
    }

    return count;
  }

  // Get cache size
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

  // Get cache hit rate
  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? 0 : (this.stats.hits / total) * 100;
  }
}

// File metadata cache entry
export interface FileMetadata {
  encoding?: 'gzip';
  mimeType: string;
}

// Global cache instances
const FILE_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
const FILE_CACHE_COUNT = 500;
const METADATA_CACHE_COUNT = 2000;

export const fileCache = new LRUCache<Buffer>(FILE_CACHE_SIZE, FILE_CACHE_COUNT);
export const metadataCache = new LRUCache<FileMetadata>(1024 * 1024, METADATA_CACHE_COUNT); // 1MB for metadata
export const rewrittenHtmlCache = new LRUCache<Buffer>(50 * 1024 * 1024, 200); // 50MB for rewritten HTML

// Helper to generate cache keys
export function getCacheKey(did: string, rkey: string, filePath: string, suffix?: string): string {
  const base = `${did}:${rkey}:${filePath}`;
  return suffix ? `${base}:${suffix}` : base;
}

// Invalidate all caches for a site
export function invalidateSiteCache(did: string, rkey: string): void {
  const fileCount = fileCache.invalidateSite(did, rkey);
  const metaCount = metadataCache.invalidateSite(did, rkey);
  const htmlCount = rewrittenHtmlCache.invalidateSite(did, rkey);

  console.log(`[Cache] Invalidated site ${did}:${rkey} - ${fileCount} files, ${metaCount} metadata, ${htmlCount} HTML`);
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
export function getCacheStats() {
  return {
    files: fileCache.getStats(),
    fileHitRate: fileCache.getHitRate(),
    metadata: metadataCache.getStats(),
    metadataHitRate: metadataCache.getHitRate(),
    rewrittenHtml: rewrittenHtmlCache.getStats(),
    rewrittenHtmlHitRate: rewrittenHtmlCache.getHitRate(),
    sitesBeingCached: sitesBeingCached.size,
  };
}
