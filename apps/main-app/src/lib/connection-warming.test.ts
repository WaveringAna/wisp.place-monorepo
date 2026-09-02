import { describe, expect, test } from 'bun:test'
import { probeConnectionWithRetry, resolveConnectionWarmingIntervalMs } from './connection-warming'

describe('probeConnectionWithRetry', () => {
	test('probes once when the connection is healthy', async () => {
		let calls = 0
		await probeConnectionWithRetry(async () => {
			calls += 1
		})

		expect(calls).toBe(1)
	})

	test('retries once when a connection is retired mid-query', async () => {
		let calls = 0
		await probeConnectionWithRetry(async () => {
			calls += 1
			// A connection reaching maxLifetime can be handed out and closed in the
			// same moment; the replacement connection serves the retry.
			if (calls === 1) throw new Error('Connection closed')
		})

		expect(calls).toBe(2)
	})

	test('surfaces the failure when the retry also fails', async () => {
		let calls = 0
		const probe = probeConnectionWithRetry(async () => {
			calls += 1
			throw new Error('primary unreachable')
		})

		await expect(probe).rejects.toThrow('primary unreachable')
		expect(calls).toBe(2)
	})
})

describe('resolveConnectionWarmingIntervalMs', () => {
	test('stays inside the pool idle timeout', () => {
		expect(resolveConnectionWarmingIntervalMs(30)).toBeLessThan(30_000)
		expect(resolveConnectionWarmingIntervalMs(300)).toBeLessThan(300_000)
	})

	test('never ticks faster than ten seconds', () => {
		expect(resolveConnectionWarmingIntervalMs(5)).toBe(10_000)
	})
})
