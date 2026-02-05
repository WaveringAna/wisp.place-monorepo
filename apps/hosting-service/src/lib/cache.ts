/**
 * Cache management for wisp-hosting-service
 *
 * With tiered storage, most caching is handled transparently.
 * This module provides a generic LRU cache and exposes storage stats.
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

// Get overall cache statistics
export async function getCacheStats() {
  const tieredStats = await storage.getStats();

  return {
    tieredStorage: tieredStats,
  };
}
