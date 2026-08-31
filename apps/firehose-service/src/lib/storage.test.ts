import { describe, expect, test } from 'bun:test'
import type { AllTierStats } from '@wispplace/tiered-storage'
import { STORAGE_STATS_STALE_AFTER_MS, StorageStatsCache } from './storage-stats-cache'

const stats: AllTierStats = {
	cold: { bytes: 42, items: 2 },
	totalHits: 0,
	totalMisses: 0,
	hitRate: 0,
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, reject, resolve }
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index++) await Promise.resolve()
}

describe('StorageStatsCache', () => {
	test('returns a local snapshot while one expensive refresh is in flight', async () => {
		const scan = deferred<AllTierStats>()
		let calls = 0
		const cache = new StorageStatsCache(async () => {
			calls++
			return await scan.promise
		})

		const first = cache.refresh()
		const second = cache.refresh()
		expect(second).toBe(first)
		expect(cache.getSnapshot()).toEqual({
			stats: null,
			lastSuccessAgeMs: null,
			lastErrorKind: null,
			stale: true,
			refreshing: true,
		})

		await flushMicrotasks()
		expect(calls).toBe(1)

		scan.resolve(stats)
		await first

		const snapshot = cache.getSnapshot()
		expect(snapshot).toMatchObject({
			stats,
			lastErrorKind: null,
			stale: false,
			refreshing: false,
		})
		expect(snapshot.lastSuccessAgeMs).toBeGreaterThanOrEqual(0)
		expect(cache.getSnapshot(Date.now() + STORAGE_STATS_STALE_AFTER_MS + 1).stale).toBe(true)
	})

	test('keeps provider error details out of the cached health data', async () => {
		const secret = 'https://bucket.example/private-key?signature=do-not-expose'
		const cache = new StorageStatsCache(async () => {
			const error = new Error(secret)
			error.name = secret
			throw error
		})

		await cache.refresh()

		const snapshot = cache.getSnapshot()
		expect(snapshot.lastErrorKind).toBe('StorageError')
		expect(snapshot.stale).toBe(true)
		expect(JSON.stringify(snapshot)).not.toContain(secret)
	})

	test('fences queued unref schedule work after stop', async () => {
		let calls = 0
		const cache = new StorageStatsCache(async () => {
			calls++
			return stats
		})

		cache.start()
		cache.stop()
		await flushMicrotasks()

		expect(calls).toBe(0)
		expect(cache.getSnapshot().refreshing).toBe(false)
	})
})
