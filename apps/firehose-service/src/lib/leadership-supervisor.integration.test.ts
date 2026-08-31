import { describe, expect, test } from 'bun:test'
import { createPrimaryAdvisorySession } from './leadership-supervisor'
import { supervisorAdvisoryLockId } from './supervisor-config'

const databaseUrl = process.env.TEST_FIREHOSE_DATABASE_URL

if (!databaseUrl) {
	describe.skip('leadership supervisor Postgres integration (requires TEST_FIREHOSE_DATABASE_URL)', () => {
		test('is skipped without an explicit disposable database URL', () => undefined)
	})
} else {
	describe('leadership supervisor Postgres integration', () => {
		test('acquires and verifies the bigint lock while excluding a second session', async () => {
			const config = { databaseUrl, commandTimeoutMs: 3_000 }
			const first = createPrimaryAdvisorySession(config)
			const second = createPrimaryAdvisorySession(config)
			const lockId = supervisorAdvisoryLockId(`integration:${crypto.randomUUID()}`)
			try {
				expect(await first.acquire(lockId, performance.now() + 3_000)).toBe(true)
				expect(await first.verify(lockId, performance.now() + 3_000)).toBe(true)
				expect(await second.acquire(lockId, performance.now() + 3_000)).toBe(false)
				await first.release(lockId, performance.now() + 3_000)
				expect(await second.acquire(lockId, performance.now() + 3_000)).toBe(true)
				expect(await second.verify(lockId, performance.now() + 3_000)).toBe(true)
				await second.release(lockId, performance.now() + 3_000)
			} finally {
				await Promise.all([first.close(), second.close()])
			}
		}, 15_000)
	})
}
