import { describe, expect, test } from 'bun:test'
import { type ReservedOAuthLockConnection, withReservedOAuthLock } from './oauth-lock'

function createConnection(
	calls: string[],
	options: { unlockFails?: boolean; closeFails?: boolean } = {},
): ReservedOAuthLockConnection {
	return {
		async acquire() {
			calls.push('acquire')
		},
		async unlock() {
			calls.push('unlock')
			if (options.unlockFails) throw new Error('unlock failed')
		},
		release() {
			calls.push('release')
		},
		async close() {
			calls.push('close')
			if (options.closeFails) throw new Error('close failed')
		},
	}
}

describe('withReservedOAuthLock', () => {
	test('releases a healthy reserved connection after unlocking', async () => {
		const calls: string[] = []
		const cleanupFailures: string[] = []
		const value = await withReservedOAuthLock(
			createConnection(calls),
			async () => {
				calls.push('fn')
				return 'result'
			},
			(kind) => cleanupFailures.push(kind),
		)

		expect(value).toBe('result')
		expect(calls).toEqual(['acquire', 'fn', 'unlock', 'release'])
		expect(cleanupFailures).toEqual([])
	})

	test('closes rather than releases a connection when advisory unlock fails', async () => {
		const calls: string[] = []
		const cleanupFailures: string[] = []
		await withReservedOAuthLock(
			createConnection(calls, { unlockFails: true }),
			async () => {
				calls.push('fn')
			},
			(kind) => cleanupFailures.push(kind),
		)

		expect(calls).toEqual(['acquire', 'fn', 'unlock', 'close'])
		expect(cleanupFailures).toEqual(['unlock'])
	})

	test('preserves a callback error when unlock and connection close both fail', async () => {
		const calls: string[] = []
		const cleanupFailures: string[] = []
		const originalError = new Error('callback failed')

		try {
			await withReservedOAuthLock(
				createConnection(calls, { unlockFails: true, closeFails: true }),
				async () => {
					calls.push('fn')
					throw originalError
				},
				(kind) => cleanupFailures.push(kind),
			)
			throw new Error('expected callback error')
		} catch (error) {
			expect(error).toBe(originalError)
		}

		expect(calls).toEqual(['acquire', 'fn', 'unlock', 'close'])
		expect(cleanupFailures).toEqual(['unlock', 'connection-close'])
	})
})
