import { describe, expect, test } from 'bun:test'
import { countStorageStatsScans } from '../scripts/storage-stats-scans'

// Spawns the real worker entry point against a fake S3 and a fake supervisor.
describe('storage-stat scans and leadership', () => {
	test('a standby worker never lists the bucket', async () => {
		const result = await countStorageStatsScans('standby', 1_500)

		expect(result.health.readiness).toBe('standby')
		expect(result.listObjectsRequests).toBe(0)
		expect(result.health.storage).toEqual({
			lastSuccessAgeMs: null,
			lastErrorKind: null,
			stale: true,
			refreshing: false,
		})
	}, 30_000)

	test('the active worker still refreshes storage stats', async () => {
		const result = await countStorageStatsScans('single', 1_500)

		expect(result.listObjectsRequests).toBe(1)
		expect(result.health.storage?.stale).toBe(false)
	}, 30_000)
})
