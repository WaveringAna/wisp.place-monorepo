import { describe, expect, test } from 'bun:test'
import { type ClosableDatabasePool, createDatabasePoolCloser } from './db'

describe('database pool closer', () => {
	test('ends the pool once across repeated calls', async () => {
		let endCalls = 0
		const pool: ClosableDatabasePool = {
			async end() {
				endCalls++
			},
		}
		const close = createDatabasePoolCloser(pool)

		const firstClose = close()
		const secondClose = close()
		expect(firstClose).toBe(secondClose)
		await Promise.all([firstClose, secondClose])
		await close()

		expect(endCalls).toBe(1)
	})

	test('reports a failed close instead of throwing', async () => {
		let reported = 0
		const pool: ClosableDatabasePool = {
			async end() {
				throw new Error('boom')
			},
		}

		await createDatabasePoolCloser(pool, () => reported++)()
		expect(reported).toBe(1)
	})
})
