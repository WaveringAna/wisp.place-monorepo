import { describe, expect, test } from 'bun:test'
import { config } from '../config'
import {
	type CacheInvalidationPublisherReadiness,
	enqueueSiteRevalidationWithRedis,
	type RevalidationQueueClient,
	waitForCacheInvalidationPublisherReady,
} from './cache-invalidation'
import { SITE_DELETE_TOMBSTONE_REASON } from './revalidate-queue'

const DID = 'did:plc:test'
const RKEY = 'site'

class FakeQueue implements RevalidationQueueClient {
	calls: Array<{ script: string; keys: string[]; args: string[] }> = []
	response: unknown = [1, '1-0']
	async eval(script: string, keyCount: number, ...args: string[]): Promise<unknown> {
		this.calls.push({ script, keys: args.slice(0, keyCount), args: args.slice(keyCount) })
		if (this.response instanceof Error) throw this.response
		return this.response
	}
}

class FakePublisherReadiness implements CacheInvalidationPublisherReadiness {
	status = 'connecting'
	private listeners = new Map<string, Set<(...args: unknown[]) => void>>()

	once(event: string, listener: (...args: unknown[]) => void): void {
		const onceListener = (...args: unknown[]) => {
			this.removeListener(event, onceListener)
			listener(...args)
		}
		const listeners = this.listeners.get(event) ?? new Set()
		listeners.add(onceListener)
		this.listeners.set(event, listeners)
	}

	removeListener(event: string, listener: (...args: unknown[]) => void): void {
		this.listeners.get(event)?.delete(listener)
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
	}
}

describe('cache invalidation publisher readiness', () => {
	test('waits for the eager Redis connection before allowing the first publish', async () => {
		const redis = new FakePublisherReadiness()
		let ready = false
		const waiting = waitForCacheInvalidationPublisherReady(redis, 1_000).then(() => {
			ready = true
		})

		await Promise.resolve()
		expect(ready).toBe(false)
		redis.status = 'ready'
		redis.emit('ready')
		await waiting
		expect(ready).toBe(true)
	})

	test('returns immediately for an already-ready publisher', async () => {
		const redis = new FakePublisherReadiness()
		redis.status = 'ready'
		await expect(waitForCacheInvalidationPublisherReady(redis, 1_000)).resolves.toBeUndefined()
	})
})

describe('enqueueSiteRevalidationWithRedis', () => {
	test('uses one atomic script that proves dedupe against an existing stream ID', async () => {
		const redis = new FakeQueue()
		expect(await enqueueSiteRevalidationWithRedis(redis, DID, RKEY, SITE_DELETE_TOMBSTONE_REASON)).toBe('enqueued')
		redis.response = [0, '1-0']
		expect(await enqueueSiteRevalidationWithRedis(redis, DID, RKEY, SITE_DELETE_TOMBSTONE_REASON)).toBe('deduplicated')
		expect(redis.calls).toHaveLength(2)
		expect(redis.calls[0]?.script).toContain('XRANGE')
		expect(redis.calls[0]?.script).toContain('XLEN')
		expect(redis.calls[0]?.script).not.toContain('MAXLEN')
		expect(redis.calls[0]?.args.slice(-2)[0]).toBe('1')
		expect(redis.calls[0]?.keys).toEqual([
			`revalidate:site:delete-tombstone:${DID}:${RKEY}`,
			config.revalidateStream,
			`wisp:revalidate:quarantine:${encodeURIComponent(DID)}/${encodeURIComponent(RKEY)}`,
		])
	})

	test('does not recreate repair work while a DLQ fence exists', async () => {
		const redis = new FakeQueue()
		redis.response = [-2, 'dlq-9']
		expect(await enqueueSiteRevalidationWithRedis(redis, DID, RKEY, 'storage-miss:index.html')).toBe('quarantined')
		expect(redis.calls[0]?.args.slice(-2)[0]).toBe('1')
	})

	test('does not report deduplicated when the atomic XADD transaction fails or has no proven job', async () => {
		const redis = new FakeQueue()
		redis.response = new Error('XADD unavailable')
		expect(await enqueueSiteRevalidationWithRedis(redis, DID, RKEY, 'storage-miss:index.html')).toBe('unavailable')
		redis.response = [0, '']
		expect(await enqueueSiteRevalidationWithRedis(redis, DID, RKEY, 'storage-miss:index.html')).toBe('unavailable')
	})

	test('applies configured hard capacity as backpressure rather than trimming pending work', async () => {
		const redis = new FakeQueue()
		redis.response = [-1, '']
		expect(await enqueueSiteRevalidationWithRedis(redis, DID, RKEY, 'storage-miss:index.html')).toBe('capacity')
		expect(redis.calls[0]?.args[0]).toBe(config.revalidateStreamMaxLen.toString())
	})
})
