import { describe, expect, test } from 'bun:test'
import { type ClosableDatabasePool, createDatabasePoolCloser } from './db'

describe('database pool closer', () => {
	test('closes separate read and write pools once across repeated calls', async () => {
		const calls: string[] = []
		const readPool: ClosableDatabasePool = {
			async end() {
				calls.push('read')
			},
		}
		const writePool: ClosableDatabasePool = {
			async end() {
				calls.push('write')
			},
		}
		const close = createDatabasePoolCloser(readPool, writePool)

		const firstClose = close()
		const secondClose = close()
		expect(firstClose).toBe(secondClose)
		await Promise.all([firstClose, secondClose])
		await close()

		expect(calls.sort()).toEqual(['read', 'write'])
	})

	test('does not end a shared read/write pool twice', async () => {
		let endCalls = 0
		const sharedPool: ClosableDatabasePool = {
			async end() {
				endCalls++
			},
		}

		await createDatabasePoolCloser(sharedPool, sharedPool)()
		expect(endCalls).toBe(1)
	})
})
