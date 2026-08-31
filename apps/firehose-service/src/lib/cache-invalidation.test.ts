import { describe, expect, test } from 'bun:test'
import { config } from '../config'
import { enqueueSiteRevalidationWithRedis, type RevalidationQueueClient } from './cache-invalidation'
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
		expect(redis.calls[0]?.keys).toEqual([`revalidate:site:delete-tombstone:${DID}:${RKEY}`, config.revalidateStream])
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
