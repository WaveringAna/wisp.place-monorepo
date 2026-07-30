import { describe, expect, test } from 'bun:test'
import { waitForSiteCacheProjection } from './site-cache-wait'

describe('waitForSiteCacheProjection', () => {
	test('waits until the projection is available', async () => {
		let checks = 0
		const ready = await waitForSiteCacheProjection(
			async () => {
				checks += 1
				return checks === 3
			},
			{ timeoutMs: 100, pollIntervalMs: 1 },
		)

		expect(ready).toBe(true)
		expect(checks).toBe(3)
	})

	test('returns false when the projection stays unavailable', async () => {
		let checks = 0
		const ready = await waitForSiteCacheProjection(
			async () => {
				checks += 1
				return false
			},
			{ timeoutMs: 0 },
		)

		expect(ready).toBe(false)
		expect(checks).toBe(1)
	})
})
