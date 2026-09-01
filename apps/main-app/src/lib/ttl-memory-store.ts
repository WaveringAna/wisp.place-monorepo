/**
 * A bounded in-memory TTL store shaped like `@atproto-labs/simple-store`.
 *
 * `NodeOAuthClient` defaults its authorization-server metadata, protected-
 * resource metadata, and DPoP nonce caches to a 60 second TTL. That is far too
 * short when a cache miss costs a round trip to a distant PDS: a user sits on
 * the consent screen for longer than 60 seconds, so every callback re-fetched
 * metadata it had just read, and the first request after each expiry paid the
 * DPoP nonce challenge again. All three are cheap to hold and safe to reuse for
 * minutes rather than seconds.
 */

export interface TtlMemoryStoreOptions {
	ttlMs: number
	max: number
}

interface Entry<V> {
	value: V
	expiresAt: number
}

export interface TtlMemoryStore<K, V> {
	get(key: K): V | undefined
	set(key: K, value: V): void
	del(key: K): void
	clear(): void
}

export const createTtlMemoryStore = <K, V>({ ttlMs, max }: TtlMemoryStoreOptions): TtlMemoryStore<K, V> => {
	const entries = new Map<K, Entry<V>>()

	const evictOldest = (): void => {
		// Map iteration is insertion-ordered and every hit re-inserts, so the
		// first entry is the least recently used.
		const oldest = entries.keys().next()
		if (!oldest.done) entries.delete(oldest.value)
	}

	return {
		get(key) {
			const entry = entries.get(key)
			if (!entry) return undefined
			if (Date.now() >= entry.expiresAt) {
				entries.delete(key)
				return undefined
			}
			entries.delete(key)
			entries.set(key, entry)
			return entry.value
		},
		set(key, value) {
			entries.delete(key)
			if (entries.size >= max) evictOldest()
			entries.set(key, { value, expiresAt: Date.now() + ttlMs })
		},
		del(key) {
			entries.delete(key)
		},
		clear() {
			entries.clear()
		},
	}
}
