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

interface InvalidationFence {
	valid: boolean
}

interface PendingFetch {
	promise: Promise<unknown>
	fence: InvalidationFence
}

function hasValidFence(fence: InvalidationFence | undefined): boolean {
	return fence?.valid ?? true
}

function isTooLargeToCache(config: NamespaceConfig, size: number): boolean {
	return config.maxSize !== undefined && size > config.maxSize
}

function shouldEvictForIncomingEntry(
	config: NamespaceConfig,
	entryCount: number,
	sizeBytes: number,
	incomingSize: number,
): boolean {
	if (entryCount === 0) return false
	if (config.maxEntries !== undefined && entryCount >= config.maxEntries) return true
	return config.maxSize !== undefined && sizeBytes + incomingSize > config.maxSize
}

export class CacheManager<NS extends string = string> {
	private namespaces: Map<NS, Map<string, CacheEntry>> = new Map()
	private configs: Map<NS, NamespaceConfig> = new Map()
	private stats: Map<NS, NamespaceStats> = new Map()
	private pendingFetches: Map<NS, Map<string, PendingFetch>> = new Map()
	private cleanupTimer: ReturnType<typeof setInterval> | null = null

	constructor(config: Record<NS, NamespaceConfig>) {
		for (const [ns, cfg] of Object.entries(config) as [NS, NamespaceConfig][]) {
			this.namespaces.set(ns, new Map())
			this.configs.set(ns, cfg)
			this.stats.set(ns, { hits: 0, misses: 0, evictions: 0, entries: 0, sizeBytes: 0 })
		}
	}

	// ── Primary API ──────────────────────────────────────────────────────

	getOrFetch<T>(ns: NS, key: string, fetcher: () => T | Promise<T>, opts?: GetOrFetchOpts<T>): Promise<T> {
		const existing = this.get<T>(ns, key)
		if (existing !== undefined) return Promise.resolve(existing)

		const pending = this.pendingFetches.get(ns)?.get(key)
		if (pending) return pending.promise as Promise<T>

		const fence: InvalidationFence = { valid: true }
		let resolvePromise!: (value: T | PromiseLike<T>) => void
		let rejectPromise!: (reason?: unknown) => void
		const promise = new Promise<T>((resolve, reject) => {
			resolvePromise = resolve
			rejectPromise = reject
		})
		const request: PendingFetch = { promise, fence }
		this.pendingFetchesFor(ns).set(key, request)

		const fetchAndCache = async (): Promise<void> => {
			try {
				const value = await fetcher()
				if (request.fence.valid) {
					const shouldCache = !opts?.cacheIf || opts.cacheIf(value)
					if (shouldCache && request.fence.valid) {
						const ttl = typeof opts?.ttl === 'function' ? opts.ttl(value) : opts?.ttl
						this.store(ns, key, value, ttl, request.fence)
					}
				}
				resolvePromise(value)
			} catch (error) {
				rejectPromise(error)
			} finally {
				this.finishPendingFetch(ns, key, request)
			}
		}

		void fetchAndCache()
		return promise
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
		this.invalidatePendingFetch(ns, key)
		this.store(ns, key, value, ttl)
	}

	private store(ns: NS, key: string, value: unknown, ttl?: number, fence?: InvalidationFence): void {
		const map = this.namespaces.get(ns)
		const cfg = this.configs.get(ns)
		const st = this.stats.get(ns)
		if (!map || !cfg || !st) return
		if (!hasValidFence(fence)) return

		const size = cfg.estimateSize ? cfg.estimateSize(value) : 0
		if (!hasValidFence(fence)) return

		// Remove an older value even when the replacement is too large to cache.
		const existing = map.get(key)
		if (existing) {
			st.sizeBytes -= existing.size
			map.delete(key)
			st.entries = map.size
		}
		if (isTooLargeToCache(cfg, size)) return

		this.evictUntilFits(map, cfg, st, size)
		map.set(key, { value, timestamp: Date.now(), size, ttl })
		st.sizeBytes += size
		st.entries = map.size
	}

	private evictUntilFits(
		map: Map<string, CacheEntry>,
		config: NamespaceConfig,
		stats: NamespaceStats,
		incomingSize: number,
	): void {
		while (shouldEvictForIncomingEntry(config, map.size, stats.sizeBytes, incomingSize)) {
			const oldest = map.keys().next().value
			if (oldest === undefined) return

			const evicted = map.get(oldest)!
			map.delete(oldest)
			stats.sizeBytes -= evicted.size
			stats.evictions++
		}
	}

	private pendingFetchesFor(ns: NS): Map<string, PendingFetch> {
		const pending = this.pendingFetches.get(ns)
		if (pending) return pending

		const created = new Map<string, PendingFetch>()
		this.pendingFetches.set(ns, created)
		return created
	}

	private finishPendingFetch(ns: NS, key: string, request: PendingFetch): void {
		const pending = this.pendingFetches.get(ns)
		if (!pending || pending.get(key) !== request) return

		pending.delete(key)
		if (pending.size === 0) this.pendingFetches.delete(ns)
	}

	/**
	 * A fenced request remains alive for its original callers, but is removed from
	 * the join map so a miss after invalidation starts a fresh fetch. The request
	 * keeps its own fence, so its later completion cannot repopulate the cache.
	 */
	private invalidatePendingFetch(ns: NS, key: string): void {
		const pending = this.pendingFetches.get(ns)
		const request = pending?.get(key)
		if (!pending || !request) return

		request.fence.valid = false
		pending.delete(key)
		if (pending.size === 0) this.pendingFetches.delete(ns)
	}

	private invalidatePendingFetchesByPrefix(ns: NS, prefix: string): void {
		const pending = this.pendingFetches.get(ns)
		if (!pending) return

		for (const [key, request] of pending) {
			if (!key.startsWith(prefix)) continue
			request.fence.valid = false
			pending.delete(key)
		}
		if (pending.size === 0) this.pendingFetches.delete(ns)
	}

	private invalidateAllPendingFetches(ns: NS): void {
		const pending = this.pendingFetches.get(ns)
		if (!pending) return

		for (const request of pending.values()) {
			request.fence.valid = false
		}
		this.pendingFetches.delete(ns)
	}

	delete(ns: NS, key: string): void {
		this.invalidatePendingFetch(ns, key)

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
		this.invalidatePendingFetchesByPrefix(ns, prefix)

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
		this.invalidateAllPendingFetches(ns)

		const map = this.namespaces.get(ns)
		const st = this.stats.get(ns)
		if (!map || !st) return

		map.clear()
		st.entries = 0
		st.sizeBytes = 0
	}

	clearAll(): void {
		for (const ns of this.namespaces.keys()) {
			this.clear(ns)
		}
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

const INVALIDATION_SAFETY_TTL_MS = 10_000
const REDIRECT_RULES_SAFETY_TTL_MS = 30_000

type CacheNamespace =
	| 'domains'
	| 'customDomains'
	| 'settings'
	| 'handles'
	| 'redirectRules'
	| 'siteCache'
	| 'siteFiles'
	| 'sourceCidMismatches'

// Invalidation remains immediate. These TTLs bound stale data when an invalidation event cannot be delivered.
export const cache = new CacheManager<CacheNamespace>({
	domains: { ttl: INVALIDATION_SAFETY_TTL_MS, maxEntries: 5000 },
	customDomains: { ttl: INVALIDATION_SAFETY_TTL_MS, maxEntries: 5000 },
	settings: { ttl: INVALIDATION_SAFETY_TTL_MS, maxEntries: 1000 },
	handles: { ttl: 10 * 60_000, maxEntries: 5000 },
	redirectRules: {
		ttl: REDIRECT_RULES_SAFETY_TTL_MS,
		maxEntries: 1000,
		maxSize: 10 * 1024 * 1024,
		estimateSize: (v) => (v as unknown[]).length * 100,
	},
	siteCache: { ttl: INVALIDATION_SAFETY_TTL_MS, maxEntries: 5000 },
	// Negative-result cache for per-site fallback files (SPA, custom 404, auto-detected 404 pages).
	// Stores null when a file is confirmed absent so repeated 404 responses don't re-hit S3.
	siteFiles: { ttl: INVALIDATION_SAFETY_TTL_MS, maxEntries: 10_000 },
	// Short-lived local markers for non-transient source-CID validation failures.
	// Invalidation clears these immediately.
	sourceCidMismatches: { ttl: INVALIDATION_SAFETY_TTL_MS, maxEntries: 10_000 },
})
