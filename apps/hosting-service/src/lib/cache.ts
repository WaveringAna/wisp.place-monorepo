/**
 * Cache statistics for wisp-hosting-service
 *
 * With tiered storage, most caching is handled transparently.
 * In-memory caches are managed by the centralized CacheManager.
 */

import { cache } from './cache-manager'
import { storage } from './storage'

// Get overall cache statistics
export async function getCacheStats() {
	const tieredStats = await storage.getStats()

	return {
		tieredStorage: tieredStats,
		inMemory: cache.getStats(),
	}
}
