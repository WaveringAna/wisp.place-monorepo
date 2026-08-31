import { describe, expect, test } from 'bun:test'
import { enqueueRevalidateWithRedis, REVALIDATE_ENQUEUE_SCRIPT, type RevalidateQueueClient } from './revalidate-queue'

describe('enqueueRevalidateWithRedis', () => {
	test('atomically releases NX dedupe when XADD fails', async () => {
		let dedupePresent = false
		const calls: Array<{ keyCount: number; keysAndArgs: string[] }> = []
		const redis: RevalidateQueueClient = {
			async eval(script, keyCount, ...keysAndArgs) {
				calls.push({ keyCount, keysAndArgs })
				expect(script).toBe(REVALIDATE_ENQUEUE_SCRIPT)
				expect(script).toContain("redis.pcall('XADD'")
				expect(script).not.toContain('MAXLEN')
				expect(script).toContain("redis.call('XRANGE'")
				expect(script).toContain("redis.call('XLEN'")
				expect(script).toContain("redis.call('DEL', KEYS[1])")

				// Model the script's atomic XADD failure cleanup path. No caller can
				// observe this temporary key outside the single EVAL execution.
				dedupePresent = true
				dedupePresent = false
				throw new Error('Redis XADD failed')
			},
		}

		const result = await enqueueRevalidateWithRedis(redis, 'did:plc:test', 'site', 'storage-miss:index.html')

		expect(result).toEqual({ enqueued: false, result: 'error' })
		expect(dedupePresent).toBe(false)
		expect(calls).toEqual([
			{
				keyCount: 2,
				keysAndArgs: [
					'revalidate:site:storage-miss:did:plc:test:site',
					'wisp:revalidate',
					'600',
					'10000',
					'did:plc:test',
					'site',
					'storage-miss:index.html',
					expect.any(String),
				],
			},
		])
	})

	test('treats a script dedupe response as deduped', async () => {
		const redis: RevalidateQueueClient = {
			async eval() {
				return [0, '123-0']
			},
		}

		await expect(enqueueRevalidateWithRedis(redis, 'did:plc:test', 'site', 'rewrite-miss:index.html')).resolves.toEqual(
			{
				enqueued: false,
				result: 'deduped',
			},
		)
	})

	test('returns hard backpressure instead of trimming pending entries at capacity', async () => {
		const redis: RevalidateQueueClient = { eval: async () => [-1, ''] }
		await expect(enqueueRevalidateWithRedis(redis, 'did:plc:test', 'site', 'storage-miss:index.html')).resolves.toEqual(
			{
				enqueued: false,
				result: 'error',
			},
		)
	})

	test('accepts only a concrete stream ID as a successful enqueue', async () => {
		const redis: RevalidateQueueClient = { eval: async () => [1, '456-0'] }
		await expect(
			enqueueRevalidateWithRedis(redis, 'did:plc:test', 'site', 'legacy-source-cid-backfill'),
		).resolves.toEqual({
			enqueued: true,
			result: 'enqueued',
		})
	})
})
