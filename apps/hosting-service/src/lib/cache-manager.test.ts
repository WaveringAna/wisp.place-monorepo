import { describe, expect, test } from 'bun:test'
import { CacheManager } from './cache-manager'

type TestNS = 'ttl' | 'lru' | 'sized' | 'combo'

function createTestCache() {
	return new CacheManager<TestNS>({
		ttl: { ttl: 100, maxEntries: 100 },
		lru: { maxEntries: 3 },
		sized: { maxEntries: 100, maxSize: 300, estimateSize: (v) => (v as string).length },
		combo: { ttl: 100, maxEntries: 3, maxSize: 500, estimateSize: (v) => (v as string).length },
	})
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

describe('CacheManager', () => {
	describe('get / set basics', () => {
		test('returns undefined for missing key', () => {
			const c = createTestCache()
			expect(c.get('ttl', 'missing')).toBeUndefined()
		})

		test('stores and retrieves a value', () => {
			const c = createTestCache()
			c.set('ttl', 'k', 42)
			expect(c.get<number>('ttl', 'k')).toBe(42)
		})

		test('namespaces are isolated', () => {
			const c = createTestCache()
			c.set('ttl', 'k', 'from-ttl')
			c.set('lru', 'k', 'from-lru')
			expect(c.get<string>('ttl', 'k')).toBe('from-ttl')
			expect(c.get<string>('lru', 'k')).toBe('from-lru')
		})

		test('overwrites existing key', () => {
			const c = createTestCache()
			c.set('lru', 'k', 'v1')
			c.set('lru', 'k', 'v2')
			expect(c.get<string>('lru', 'k')).toBe('v2')
		})
	})

	describe('TTL expiry', () => {
		test('returns value within TTL', () => {
			const c = createTestCache()
			c.set('ttl', 'k', 'fresh')
			expect(c.get<string>('ttl', 'k')).toBe('fresh')
		})

		test('expires stale entries after the safety TTL and releases their stats', async () => {
			const c = createTestCache()
			c.set('ttl', 'k', 'stale')
			await Bun.sleep(150)
			expect(c.get('ttl', 'k')).toBeUndefined()
			expect(c.getStats().ttl).toMatchObject({ entries: 0, sizeBytes: 0, misses: 1 })
		})
	})

	describe('LRU eviction by maxEntries', () => {
		test('evicts oldest entry when maxEntries exceeded', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			c.set('lru', 'c', 3)
			// At capacity (3). Adding a 4th should evict 'a' (oldest).
			c.set('lru', 'd', 4)
			expect(c.getStats().lru).toMatchObject({ entries: 3, sizeBytes: 0, evictions: 1 })
			expect(c.get<number>('lru', 'a')).toBeUndefined()
			expect(c.get<number>('lru', 'b')).toBe(2)
			expect(c.get<number>('lru', 'd')).toBe(4)
		})

		test('accessing a key refreshes its LRU position', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			c.set('lru', 'c', 3)
			// Touch 'a' so it's no longer the oldest
			c.get('lru', 'a')
			// Now 'b' is the oldest
			c.set('lru', 'd', 4)
			expect(c.get<number>('lru', 'b')).toBeUndefined()
			expect(c.get<number>('lru', 'a')).toBe(1)
		})
	})

	describe('LRU eviction by maxSize', () => {
		test('evicts entries when maxSize exceeded', () => {
			const c = createTestCache()
			// sized ns: maxSize=300, estimateSize = string length
			c.set('sized', 'a', 'x'.repeat(100))
			c.set('sized', 'b', 'x'.repeat(100))
			c.set('sized', 'c', 'x'.repeat(100))
			// At 300 bytes. Adding 150 more should evict until it fits.
			c.set('sized', 'd', 'x'.repeat(150))
			expect(c.getStats().sized).toMatchObject({ entries: 2, sizeBytes: 250, evictions: 2 })
			expect(c.get('sized', 'a')).toBeUndefined()
			expect(c.get('sized', 'd')).toBeDefined()
		})
	})

	describe('delete', () => {
		test('removes a key', () => {
			const c = createTestCache()
			c.set('lru', 'k', 'val')
			c.delete('lru', 'k')
			expect(c.get('lru', 'k')).toBeUndefined()
		})

		test('delete on missing key is a no-op', () => {
			const c = createTestCache()
			c.delete('lru', 'nonexistent') // should not throw
		})
	})

	describe('clear', () => {
		test('removes all entries in a namespace', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			c.set('ttl', 'x', 3)
			c.clear('lru')
			expect(c.get<number>('lru', 'a')).toBeUndefined()
			expect(c.get<number>('lru', 'b')).toBeUndefined()
			// Other namespace untouched
			expect(c.get<number>('ttl', 'x')).toBe(3)
		})

		test('clearAll clears every namespace while preserving cumulative stats', () => {
			const c = createTestCache()
			c.set('ttl', 'a', 1)
			c.set('lru', 'b', 2)
			c.set('sized', 'c', 'size')
			c.get('lru', 'b')

			c.clearAll()

			const stats = c.getStats()
			expect(stats.ttl).toMatchObject({ entries: 0, sizeBytes: 0, hits: 0, misses: 0 })
			expect(stats.lru).toMatchObject({ entries: 0, sizeBytes: 0, hits: 1, misses: 0 })
			expect(stats.sized).toMatchObject({ entries: 0, sizeBytes: 0, hits: 0, misses: 0 })
		})

		test('clearAll fences pending fetches so stale completions cannot repopulate a namespace', async () => {
			const c = createTestCache()
			const stale = createDeferred<string>()
			const fresh = createDeferred<string>()
			let calls = 0
			const staleRequest = c.getOrFetch('ttl', 'pending', () => {
				calls++
				return stale.promise
			})

			c.clearAll()
			const freshRequest = c.getOrFetch('ttl', 'pending', () => {
				calls++
				return fresh.promise
			})
			expect(calls).toBe(2)

			stale.resolve('stale')
			expect(await staleRequest).toBe('stale')
			expect(c.get('ttl', 'pending')).toBeUndefined()
			fresh.resolve('fresh')
			expect(await freshRequest).toBe('fresh')
			expect(c.get<string>('ttl', 'pending')).toBe('fresh')
		})
	})

	describe('getOrFetch', () => {
		test('calls fetcher on cache miss', async () => {
			const c = createTestCache()
			let called = 0
			const val = await c.getOrFetch('lru', 'k', () => {
				called++
				return 'fetched'
			})
			expect(val).toBe('fetched')
			expect(called).toBe(1)
		})

		test('returns cached value without calling fetcher', async () => {
			const c = createTestCache()
			c.set('lru', 'k', 'cached')
			let called = 0
			const val = await c.getOrFetch('lru', 'k', () => {
				called++
				return 'fetched'
			})
			expect(val).toBe('cached')
			expect(called).toBe(0)
		})

		test('works with async fetcher', async () => {
			const c = createTestCache()
			const val = await c.getOrFetch('lru', 'k', async () => {
				await Bun.sleep(5)
				return 'async-result'
			})
			expect(val).toBe('async-result')
			// Second call should be from cache
			expect(c.get<string>('lru', 'k')).toBe('async-result')
		})

		test('shares one in-flight fetch across concurrent cache misses', async () => {
			const c = createTestCache()
			const deferred = createDeferred<string>()
			let calls = 0
			const first = c.getOrFetch('lru', 'k', () => {
				calls++
				return deferred.promise
			})
			const second = c.getOrFetch('lru', 'k', () => {
				calls++
				return 'second fetch should not run'
			})

			expect(calls).toBe(1)
			deferred.resolve('shared')
			expect(await first).toBe('shared')
			expect(await second).toBe('shared')
			expect(c.get<string>('lru', 'k')).toBe('shared')
		})

		test('keeps in-flight fetches isolated by namespace and key', async () => {
			const c = createTestCache()
			const firstValue = createDeferred<string>()
			const secondValue = createDeferred<string>()
			const thirdValue = createDeferred<string>()
			let calls = 0
			const first = c.getOrFetch('lru', 'same-key', () => {
				calls++
				return firstValue.promise
			})
			const second = c.getOrFetch('lru', 'other-key', () => {
				calls++
				return secondValue.promise
			})
			const third = c.getOrFetch('ttl', 'same-key', () => {
				calls++
				return thirdValue.promise
			})

			expect(calls).toBe(3)
			firstValue.resolve('first')
			secondValue.resolve('second')
			thirdValue.resolve('third')
			expect(await first).toBe('first')
			expect(await second).toBe('second')
			expect(await third).toBe('third')
		})

		test('shares a rejected fetch and removes it so a later request can retry', async () => {
			const c = createTestCache()
			const deferred = createDeferred<string>()
			const error = new Error('fetch failed')
			let calls = 0
			const first = c.getOrFetch('lru', 'k', () => {
				calls++
				return deferred.promise
			})
			const second = c.getOrFetch('lru', 'k', () => {
				calls++
				return 'second fetch should not run'
			})
			const outcomes = Promise.allSettled([first, second])

			expect(calls).toBe(1)
			deferred.reject(error)
			const [firstOutcome, secondOutcome] = await outcomes
			expect(firstOutcome).toEqual({ status: 'rejected', reason: error })
			expect(secondOutcome).toEqual({ status: 'rejected', reason: error })

			expect(
				await c.getOrFetch('lru', 'k', () => {
					calls++
					return 'retried'
				}),
			).toBe('retried')
			expect(calls).toBe(2)
		})

		test('delete fences an in-flight fetch and keeps a newer pending fetch joinable', async () => {
			const c = createTestCache()
			const stale = createDeferred<string>()
			const fresh = createDeferred<string>()
			let calls = 0
			const staleRequest = c.getOrFetch('lru', 'k', () => {
				calls++
				return stale.promise
			})

			c.delete('lru', 'k')
			const freshRequest = c.getOrFetch('lru', 'k', () => {
				calls++
				return fresh.promise
			})
			expect(calls).toBe(2)

			stale.resolve('stale')
			expect(await staleRequest).toBe('stale')
			expect(c.get('lru', 'k')).toBeUndefined()

			const joinedFreshRequest = c.getOrFetch('lru', 'k', () => {
				calls++
				return 'third fetch should not run'
			})
			expect(calls).toBe(2)
			fresh.resolve('fresh')
			expect(await freshRequest).toBe('fresh')
			expect(await joinedFreshRequest).toBe('fresh')
			expect(c.get<string>('lru', 'k')).toBe('fresh')
		})

		test('deletePrefix fences matching in-flight fetches', async () => {
			const c = createTestCache()
			const stale = createDeferred<string>()
			const fresh = createDeferred<string>()
			let calls = 0
			const staleRequest = c.getOrFetch('lru', 'site:page', () => {
				calls++
				return stale.promise
			})

			c.deletePrefix('lru', 'site:')
			const freshRequest = c.getOrFetch('lru', 'site:page', () => {
				calls++
				return fresh.promise
			})
			expect(calls).toBe(2)

			stale.resolve('stale')
			expect(await staleRequest).toBe('stale')
			expect(c.get('lru', 'site:page')).toBeUndefined()

			const joinedFreshRequest = c.getOrFetch('lru', 'site:page', () => {
				calls++
				return 'third fetch should not run'
			})
			expect(calls).toBe(2)
			fresh.resolve('fresh')
			expect(await freshRequest).toBe('fresh')
			expect(await joinedFreshRequest).toBe('fresh')
			expect(c.get<string>('lru', 'site:page')).toBe('fresh')
		})

		test('clear fences all in-flight fetches in a namespace', async () => {
			const c = createTestCache()
			const staleFirst = createDeferred<string>()
			const staleSecond = createDeferred<string>()
			const fresh = createDeferred<string>()
			let calls = 0
			const firstRequest = c.getOrFetch('lru', 'first', () => {
				calls++
				return staleFirst.promise
			})
			const secondRequest = c.getOrFetch('lru', 'second', () => {
				calls++
				return staleSecond.promise
			})

			c.clear('lru')
			const freshRequest = c.getOrFetch('lru', 'first', () => {
				calls++
				return fresh.promise
			})
			expect(calls).toBe(3)

			staleFirst.resolve('stale first')
			staleSecond.resolve('stale second')
			expect(await firstRequest).toBe('stale first')
			expect(await secondRequest).toBe('stale second')
			expect(c.get('lru', 'first')).toBeUndefined()
			expect(c.get('lru', 'second')).toBeUndefined()

			const joinedFreshRequest = c.getOrFetch('lru', 'first', () => {
				calls++
				return 'fourth fetch should not run'
			})
			expect(calls).toBe(3)
			fresh.resolve('fresh')
			expect(await freshRequest).toBe('fresh')
			expect(await joinedFreshRequest).toBe('fresh')
			expect(c.get<string>('lru', 'first')).toBe('fresh')
		})

		test('explicit set fences an in-flight fetch without letting it overwrite the set value', async () => {
			const c = createTestCache()
			const stale = createDeferred<string>()
			let calls = 0
			const staleRequest = c.getOrFetch('lru', 'k', () => {
				calls++
				return stale.promise
			})

			c.set('lru', 'k', 'explicit')
			expect(
				await c.getOrFetch('lru', 'k', () => {
					calls++
					return 'fetch should not run'
				}),
			).toBe('explicit')
			expect(calls).toBe(1)

			stale.resolve('stale')
			expect(await staleRequest).toBe('stale')
			expect(c.get<string>('lru', 'k')).toBe('explicit')
		})

		test('cacheIf: false skips caching', async () => {
			const c = createTestCache()
			const val = await c.getOrFetch('lru', 'k', () => null, {
				cacheIf: (v) => v !== null,
			})
			expect(val).toBeNull()
			// Should NOT be cached
			expect(c.get('lru', 'k')).toBeUndefined()
		})

		test('cacheIf: true caches normally', async () => {
			const c = createTestCache()
			const val = await c.getOrFetch('lru', 'k', () => 'good', {
				cacheIf: (v) => v !== null,
			})
			expect(val).toBe('good')
			expect(c.get<string>('lru', 'k')).toBe('good')
		})
	})

	describe('stats', () => {
		test('tracks hits and misses', () => {
			const c = createTestCache()
			c.get('lru', 'miss1')
			c.get('lru', 'miss2')
			c.set('lru', 'k', 'v')
			c.get('lru', 'k')
			const stats = c.getStats()
			expect(stats.lru.misses).toBe(2)
			expect(stats.lru.hits).toBe(1)
		})

		test('tracks evictions', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			c.set('lru', 'c', 3)
			c.set('lru', 'd', 4) // evicts 'a'
			const stats = c.getStats()
			expect(stats.lru.evictions).toBe(1)
		})

		test('tracks entries count', () => {
			const c = createTestCache()
			c.set('lru', 'a', 1)
			c.set('lru', 'b', 2)
			expect(c.getStats().lru.entries).toBe(2)
			c.delete('lru', 'a')
			expect(c.getStats().lru.entries).toBe(1)
		})

		test('tracks sizeBytes with estimateSize', () => {
			const c = createTestCache()
			c.set('sized', 'a', 'hello') // 5 bytes
			c.set('sized', 'b', 'world!') // 6 bytes
			expect(c.getStats().sized.sizeBytes).toBe(11)
			c.delete('sized', 'a')
			expect(c.getStats().sized.sizeBytes).toBe(6)
		})

		test('does not retain a value larger than the namespace byte cap', () => {
			const c = createTestCache()
			c.set('sized', 'key', 'small')
			c.set('sized', 'key', 'x'.repeat(301))

			expect(c.get('sized', 'key')).toBeUndefined()
			expect(c.getStats().sized).toMatchObject({ entries: 0, sizeBytes: 0 })
		})

		test('returns independent stats per namespace', () => {
			const c = createTestCache()
			c.set('ttl', 'a', 1)
			c.set('lru', 'b', 2)
			const stats = c.getStats()
			expect(stats.ttl.entries).toBe(1)
			expect(stats.lru.entries).toBe(1)
			expect(stats.sized.entries).toBe(0)
		})
	})

	describe('cleanup', () => {
		test('startCleanup / stopCleanup do not throw', () => {
			const c = createTestCache()
			c.startCleanup(50)
			c.stopCleanup()
		})

		test('cleanup sweeps expired TTL entries', async () => {
			const c = createTestCache()
			c.set('ttl', 'k', 'val')
			c.startCleanup(50)
			// Wait for TTL (100ms) + cleanup interval (50ms) + buffer
			await Bun.sleep(200)
			c.stopCleanup()
			expect(c.get('ttl', 'k')).toBeUndefined()
		})

		test('cleanup does not touch non-TTL namespaces', async () => {
			const c = createTestCache()
			c.set('lru', 'k', 'val')
			c.startCleanup(50)
			await Bun.sleep(200)
			c.stopCleanup()
			expect(c.get<string>('lru', 'k')).toBe('val')
		})
	})
})
