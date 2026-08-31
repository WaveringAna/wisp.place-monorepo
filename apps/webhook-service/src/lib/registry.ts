import { LRUCache } from 'lru-cache'
import { config } from '../config'
import type { WebhookEntry } from './db'

/** Reserved cache key for the bounded backlinks query. */
export const BACKLINK_CACHE_KEY = '__backlinks__'

/**
 * DB query results keyed by scoped DID. Empty arrays are deliberate cache values:
 * a high-volume DID without subscriptions must not trigger a DB query per event.
 */
const cache = new LRUCache<string, readonly WebhookEntry[]>({
	max: config.webhookCacheMax,
	ttl: config.webhookCacheTtlMs,
	updateAgeOnGet: false,
	allowStale: false,
})

// Per-key generations prevent stale fills without invalidating unrelated cache
// entries. The map is hard-bounded; evicting metadata advances a global epoch so
// an old in-flight token can never match a freshly absent key.
const generations = new Map<string, number>()
let globalGeneration = 0
const MAX_GENERATION_KEYS = config.webhookCacheMax

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		if ((value.charCodeAt(index) || 0) < 32) return true
	}
	return false
}

function validCacheKey(key: string): boolean {
	return key === BACKLINK_CACHE_KEY || (key.length > 0 && key.length <= 2_048 && !hasControlCharacter(key))
}

export function getCached(scopeDid: string): readonly WebhookEntry[] | undefined {
	if (!validCacheKey(scopeDid)) return undefined
	return cache.get(scopeDid)
}

export function getCacheGeneration(scopeDid: string): string {
	return validCacheKey(scopeDid) ? `${globalGeneration}:${generations.get(scopeDid) ?? 0}` : 'invalid'
}

export function setCachedIfCurrent(scopeDid: string, entries: readonly WebhookEntry[], generation: string): boolean {
	if (!validCacheKey(scopeDid) || getCacheGeneration(scopeDid) !== generation) return false
	// Copy the array so callers cannot mutate a cached empty/non-empty result after storing it.
	cache.set(scopeDid, [...entries])
	return true
}

export function setCached(scopeDid: string, entries: readonly WebhookEntry[]): void {
	setCachedIfCurrent(scopeDid, entries, getCacheGeneration(scopeDid))
}

export function invalidate(scopeDid: string): void {
	if (!validCacheKey(scopeDid)) return
	if (!generations.has(scopeDid) && generations.size >= MAX_GENERATION_KEYS) {
		globalGeneration++
		generations.clear()
	}
	generations.set(scopeDid, (generations.get(scopeDid) ?? 0) + 1)
	cache.delete(scopeDid)
}

export function invalidateMany(scopeDids: Iterable<string>): void {
	for (const scopeDid of scopeDids) invalidate(scopeDid)
}

export function clearRegistryCache(): void {
	globalGeneration++
	generations.clear()
	cache.clear()
}

export function getRegistryCacheSize(): number {
	return cache.size
}
