/**
 * Centralized in-memory cache manager for the hosting service.
 *
 * Replaces the scattered TTL Maps (domains, customDomains, settings, handles)
 * and the LRU redirect-rules cache with a single, namespace-aware cache.
 */

interface NamespaceConfig {
	/** Time-to-live in milliseconds. Entries older than this are stale. */
	ttl?: number
	/** Maximum number of entries before LRU eviction kicks in. */
	maxEntries?: number
	/** Maximum total estimated size (bytes) before LRU eviction kicks in. */
	maxSize?: number
	/** Estimate the byte size of a value. Required when maxSize is set. */
	estimateSize?: (value: unknown) => number
}

interface CacheEntry {
	value: unknown
	timestamp: number
	size: number
	ttl?: number
}

interface NamespaceStats {
	hits: number
	misses: number
	evictions: number
	entries: number
	sizeBytes: number
}

interface GetOrFetchOpts<T> {
	/** Skip caching when predicate returns false (e.g. don't cache null). */
	cacheIf?: (value: T) => boolean
	/** Per-entry TTL override (ms). Can be a number or a function of the value. */
	ttl?: number | ((value: T) => number | undefined)
}

export class CacheManager<NS extends string = string> {
	private namespaces: Map<NS, Map<string, CacheEntry>> = new Map()
	private configs: Map<NS, NamespaceConfig> = new Map()
	private stats: Map<NS, NamespaceStats> = new Map()
	private cleanupTimer: ReturnType<typeof setInterval> | null = null

	constructor(config: Record<NS, NamespaceConfig>) {
		for (const [ns, cfg] of Object.entries(config) as [NS, NamespaceConfig][]) {
			this.namespaces.set(ns, new Map())
			this.configs.set(ns, cfg)
			this.stats.set(ns, { hits: 0, misses: 0, evictions: 0, entries: 0, sizeBytes: 0 })
		}
	}

	// ── Primary API ──────────────────────────────────────────────────────

	async getOrFetch<T>(ns: NS, key: string, fetcher: () => T | Promise<T>, opts?: GetOrFetchOpts<T>): Promise<T> {
		const existing = this.get<T>(ns, key)
		if (existing !== undefined) return existing

		const value = await fetcher()

		if (!opts?.cacheIf || opts.cacheIf(value)) {
			const ttl = typeof opts?.ttl === 'function' ? opts.ttl(value) : opts?.ttl
			this.set(ns, key, value, ttl)
		}

		return value
	}

	get<T>(ns: NS, key: string): T | undefined {
		const map = this.namespaces.get(ns)
		const cfg = this.configs.get(ns)
		const st = this.stats.get(ns)
		if (!map || !cfg || !st) return undefined

		const entry = map.get(key)
		if (!entry) {
			st.misses++
			return undefined
		}

		// TTL check (per-entry override takes precedence over namespace default)
		const effectiveTtl = entry.ttl ?? cfg.ttl
		if (effectiveTtl && Date.now() - entry.timestamp > effectiveTtl) {
			map.delete(key)
			st.entries = map.size
			st.sizeBytes -= entry.size
			st.misses++
			return undefined
		}

		// Touch for LRU: delete + re-insert moves to end of Map iteration order
		map.delete(key)
		map.set(key, entry)

		st.hits++
		return entry.value as T
	}

	set(ns: NS, key: string, value: unknown, ttl?: number): void {
		const map = this.namespaces.get(ns)
		const cfg = this.configs.get(ns)
		const st = this.stats.get(ns)
		if (!map || !cfg || !st) return

		const size = cfg.estimateSize ? cfg.estimateSize(value) : 0

		// Remove existing entry first
		const existing = map.get(key)
		if (existing) {
			st.sizeBytes -= existing.size
			map.delete(key)
		}

		// LRU eviction
		while (map.size > 0) {
			const overCount = cfg.maxEntries !== undefined && map.size >= cfg.maxEntries
			const overSize = cfg.maxSize !== undefined && st.sizeBytes + size > cfg.maxSize
			if (!overCount && !overSize) break

			const oldest = map.keys().next().value
			if (oldest === undefined) break
			const evicted = map.get(oldest)!
			map.delete(oldest)
			st.sizeBytes -= evicted.size
			st.evictions++
		}

		map.set(key, { value, timestamp: Date.now(), size, ttl })
		st.sizeBytes += size
		st.entries = map.size
	}

	delete(ns: NS, key: string): void {
		const map = this.namespaces.get(ns)
		const st = this.stats.get(ns)
		if (!map || !st) return

		const entry = map.get(key)
		if (entry) {
			map.delete(key)
			st.sizeBytes -= entry.size
			st.entries = map.size
		}
	}

	deletePrefix(ns: NS, prefix: string): void {
		const map = this.namespaces.get(ns)
		const st = this.stats.get(ns)
		if (!map || !st) return

		for (const [key, entry] of map) {
			if (key.startsWith(prefix)) {
				map.delete(key)
				st.sizeBytes -= entry.size
			}
		}
		st.entries = map.size
	}

	clear(ns: NS): void {
		const map = this.namespaces.get(ns)
		const st = this.stats.get(ns)
		if (!map || !st) return

		map.clear()
		st.entries = 0
		st.sizeBytes = 0
	}

	// ── Stats ────────────────────────────────────────────────────────────

	getStats(): Record<NS, NamespaceStats> {
		const out = {} as Record<NS, NamespaceStats>
		for (const [ns, st] of this.stats) {
			out[ns] = { ...st }
		}
		return out
	}

	// ── Periodic cleanup ─────────────────────────────────────────────────

	startCleanup(intervalMs = 30 * 60_000): void {
		if (this.cleanupTimer) return

		this.cleanupTimer = setInterval(() => {
			const now = Date.now()
			for (const [ns, cfg] of this.configs) {
				const map = this.namespaces.get(ns)!
				const st = this.stats.get(ns)!
				for (const [key, entry] of map) {
					const effectiveTtl = entry.ttl ?? cfg.ttl
					if (effectiveTtl && now - entry.timestamp > effectiveTtl) {
						map.delete(key)
						st.sizeBytes -= entry.size
					}
				}
				st.entries = map.size
			}
		}, intervalMs)
	}

	stopCleanup(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer)
			this.cleanupTimer = null
		}
	}
}

// ── Singleton ────────────────────────────────────────────────────────────

type CacheNamespace = 'domains' | 'customDomains' | 'settings' | 'handles' | 'redirectRules' | 'siteCache' | 'siteFiles'

export const cache = new CacheManager<CacheNamespace>({
	domains: { ttl: 5 * 60_000, maxEntries: 5000 },
	customDomains: { ttl: 5 * 60_000, maxEntries: 5000 },
	settings: { ttl: 5 * 60_000, maxEntries: 1000 },
	handles: { ttl: 10 * 60_000, maxEntries: 5000 },
	redirectRules: { maxEntries: 1000, maxSize: 10 * 1024 * 1024, estimateSize: (v) => (v as unknown[]).length * 100 },
	siteCache: { ttl: 5 * 60_000, maxEntries: 5000 },
	// Negative-result cache for per-site fallback files (SPA, custom 404, auto-detected 404 pages).
	// Stores null when a file is confirmed absent so repeated 404 responses don't re-hit S3.
	siteFiles: { ttl: 5 * 60_000, maxEntries: 10_000 },
})
