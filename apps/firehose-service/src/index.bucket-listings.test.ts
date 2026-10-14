import { describe, expect, test } from 'bun:test'
import { countBucketListings } from '../scripts/bucket-listings'

// Spawns the real worker entry point against a fake S3 and a fake supervisor.
// Nothing reads a bucket-wide size, so no worker lists the bucket on its own.
describe('bucket listings', () => {
	for (const role of ['standby', 'single'] as const) {
		test(`a ${role} worker never lists the bucket or reports storage stats`, async () => {
			const result = await countBucketListings(role, 1_500)

			expect(result.listObjectsRequests).toBe(0)
			expect(result.health).not.toHaveProperty('storage')
			if (role === 'standby') expect(result.health.readiness).toBe('standby')
		}, 30_000)
	}
})
