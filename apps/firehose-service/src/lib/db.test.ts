import { beforeEach, describe, expect, test } from 'bun:test'
import {
	LOCK_POOL_RESERVE_TIMEOUT_MS,
	SiteWriteLockAcquisitionError,
	type SiteWriteLockConnection,
	SiteWriteLockPool,
	type SiteWriteLockPoolClient,
	type SiteWriteLockReservedClient,
	siteWriteLockId,
	withReservedSiteWriteLock,
} from './db'

const commands: string[] = []
const commandValues: unknown[][] = []
let acquireError: Error | null = null
let unlockError: Error | null = null
let closeError: Error | null = null
let releaseError: Error | null = null
let unlockResult: unknown[] = [{ unlocked: true }]
let releases = 0
let closes = 0
const closeOptions: Array<{ timeout: number }> = []

const connection = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
	const command = strings.join('?')
	commands.push(command)
	commandValues.push(values)
	if (command.includes('pg_advisory_lock') && acquireError) throw acquireError
	if (command.includes('pg_advisory_unlock') && unlockError) throw unlockError
	if (command.includes('pg_advisory_unlock')) return unlockResult
	return []
}) as unknown as SiteWriteLockConnection
connection.release = () => {
	releases += 1
	if (releaseError) throw releaseError
}
connection.close = async (options) => {
	closes += 1
	closeOptions.push(options)
	if (closeError) throw closeError
}

beforeEach(() => {
	commands.length = 0
	commandValues.length = 0
	acquireError = null
	unlockError = null
	closeError = null
	releaseError = null
	unlockResult = [{ unlocked: true }]
	releases = 0
	closes = 0
	closeOptions.length = 0
})

type FakePoolClient = {
	client: SiteWriteLockPoolClient
	reserved: SiteWriteLockReservedClient
	reserveCalls: number
	releaseCalls: number
	endCalls: Array<{ timeout: number }>
}

function fakePoolClient(
	options: { reserve?: Promise<SiteWriteLockReservedClient>; endError?: Error } = {},
): FakePoolClient {
	let reserveCalls = 0
	let releaseCalls = 0
	const endCalls: Array<{ timeout: number }> = []
	const reserved = (async (
		_strings: TemplateStringsArray,
		..._values: unknown[]
	) => []) as unknown as SiteWriteLockReservedClient
	const originalRelease = () => {
		releaseCalls++
	}
	reserved.release = originalRelease
	const client: SiteWriteLockPoolClient = {
		reserve: async () => {
			reserveCalls++
			return options.reserve ? await options.reserve : reserved
		},
		end: async (endOptions) => {
			endCalls.push(endOptions)
			if (options.endError) throw options.endError
		},
	}
	return {
		client,
		reserved,
		get reserveCalls() {
			return reserveCalls
		},
		get releaseCalls() {
			return releaseCalls
		},
		endCalls,
	}
}

describe('withReservedSiteWriteLock', () => {
	test('derives stable, distinct 63-bit bigint lock ids without Number precision loss', () => {
		const first = siteWriteLockId('did:plc:test', 'site')
		expect(first).toBe(siteWriteLockId('did:plc:test', 'site'))
		expect(first).not.toBe(siteWriteLockId('did:plc:test', 'other-site'))
		expect(typeof first).toBe('bigint')
		expect(first).toBe(4515102725203664269n)
		expect(first).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
	})

	test('fails closed and never invokes the callback when lock acquisition times out', async () => {
		acquireError = new Error('postgres://db-user:secret@example.invalid connection failed')
		let callbackCalls = 0
		let thrown: unknown

		try {
			await withReservedSiteWriteLock(connection, 'did:plc:test', 'site', async () => {
				callbackCalls += 1
				return 'written'
			})
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(SiteWriteLockAcquisitionError)
		const lockError = thrown as SiteWriteLockAcquisitionError
		expect(lockError.message).toBe('Failed to acquire site-write lock')
		expect(lockError.message).not.toContain('postgres://')
		expect(lockError.errorKind).toBe('Error')
		expect(callbackCalls).toBe(0)
		expect(commands).toContain("SET lock_timeout = '120s'")
		expect(commands.some((command) => command.includes('pg_advisory_lock'))).toBe(true)
		expect(commands.some((command) => command.includes('pg_advisory_unlock'))).toBe(false)
		expect(releases).toBe(1)
		expect(closes).toBe(0)
	})

	test('cancels a blocked advisory lock and closes the reserved session', async () => {
		const controller = new AbortController()
		let callbackCalls = 0
		let cancelCalls = 0
		let closeCalls = 0
		let releaseCalls = 0
		let resolveLockStarted!: () => void
		let rejectLock!: (error: Error) => void
		const lockStarted = new Promise<void>((resolve) => {
			resolveLockStarted = resolve
		})
		const lockQuery = new Promise<unknown>((_resolve, reject) => {
			rejectLock = reject
		}) as Promise<unknown> & { cancel?: () => void }
		lockQuery.cancel = () => {
			cancelCalls += 1
			rejectLock(new Error('query cancelled'))
		}
		const cancellableConnection = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
			const command = strings.join('?')
			if (command.includes('pg_advisory_lock')) {
				resolveLockStarted()
				return lockQuery
			}
			return Promise.resolve([])
		}) as unknown as SiteWriteLockConnection
		cancellableConnection.release = () => {
			releaseCalls += 1
		}
		cancellableConnection.close = async () => {
			closeCalls += 1
		}

		const processing = withReservedSiteWriteLock(
			cancellableConnection,
			'did:plc:test',
			'site',
			async () => {
				callbackCalls += 1
			},
			controller.signal,
		)
		await lockStarted
		controller.abort()

		await expect(processing).rejects.toBeInstanceOf(SiteWriteLockAcquisitionError)
		expect(cancelCalls).toBe(1)
		expect(callbackCalls).toBe(0)
		expect(closeCalls).toBe(1)
		expect(releaseCalls).toBe(0)
	})

	test('keeps the bigint id through advisory lock and unlock calls', async () => {
		await expect(withReservedSiteWriteLock(connection, 'did:plc:test', 'site', async () => 'written')).resolves.toBe(
			'written',
		)

		const lockValues = commands
			.map((command, index) => ({ command, values: commandValues[index] ?? [] }))
			.filter(({ command }) => command.includes('pg_advisory_'))
			.map(({ values }) => values[0])
		expect(lockValues).toEqual([siteWriteLockId('did:plc:test', 'site'), siteWriteLockId('did:plc:test', 'site')])
		expect(lockValues.every((value) => typeof value === 'bigint')).toBe(true)
		expect(releases).toBe(1)
		expect(closes).toBe(0)
	})

	test('releases the dedicated connection and advisory lock after a successful callback', async () => {
		await expect(withReservedSiteWriteLock(connection, 'did:plc:test', 'site', async () => 'written')).resolves.toBe(
			'written',
		)

		expect(commands.some((command) => command.includes('pg_advisory_lock'))).toBe(true)
		expect(commands.some((command) => command.includes('pg_advisory_unlock'))).toBe(true)
		expect(releases).toBe(1)
		expect(closes).toBe(0)
	})

	test('closes instead of releasing a connection when advisory unlock fails', async () => {
		unlockError = new Error('connection reset while releasing lock')

		await expect(withReservedSiteWriteLock(connection, 'did:plc:test', 'site', async () => 'written')).resolves.toBe(
			'written',
		)

		expect(commands.some((command) => command.includes('pg_advisory_lock'))).toBe(true)
		expect(commands.some((command) => command.includes('pg_advisory_unlock'))).toBe(true)
		expect(releases).toBe(0)
		expect(closes).toBe(1)
		expect(closeOptions).toEqual([{ timeout: 0 }])
	})

	test('quarantines a connection when advisory unlock returns false', async () => {
		unlockResult = [{ unlocked: false }]

		await expect(withReservedSiteWriteLock(connection, 'did:plc:test', 'site', async () => 'written')).resolves.toBe(
			'written',
		)

		expect(releases).toBe(0)
		expect(closes).toBe(1)
		expect(closeOptions).toEqual([{ timeout: 0 }])
	})

	test('does not let unlock or close cleanup failures mask a callback error', async () => {
		unlockError = new Error('unlock failed')
		closeError = new Error('postgres://db-user:secret@example.invalid close failed')
		const callbackError = new Error('write failed')

		await expect(
			withReservedSiteWriteLock(connection, 'did:plc:test', 'site', async () => {
				throw callbackError
			}),
		).rejects.toBe(callbackError)

		expect(releases).toBe(0)
		expect(closes).toBe(1)
		expect(closeOptions).toEqual([{ timeout: 0 }])
	})

	test('does not let release cleanup failure mask a callback error', async () => {
		releaseError = new Error('release failed')
		const callbackError = new Error('write failed')

		await expect(
			withReservedSiteWriteLock(connection, 'did:plc:test', 'site', async () => {
				throw callbackError
			}),
		).rejects.toBe(callbackError)

		expect(releases).toBe(1)
		expect(closes).toBe(0)
	})
})

describe('SiteWriteLockPool', () => {
	test('bounds reserve waits when every lock slot is exhausted', async () => {
		const created: FakePoolClient[] = []
		const pool = new SiteWriteLockPool({
			size: 1,
			reserveTimeoutMs: 5,
			createClient: () => {
				const fake = fakePoolClient()
				created.push(fake)
				return fake.client
			},
		})
		const held = await pool.reserve()
		const waiting = pool.reserve()

		await expect(waiting).rejects.toThrow('Timed out waiting for a site write lock connection')
		held.release()
		await pool.end({ timeout: 0 })
		expect(created).toHaveLength(1)
		expect(created[0]?.releaseCalls).toBe(1)
	})

	test('cancels a queued reservation immediately when its lifecycle signal aborts', async () => {
		const fake = fakePoolClient()
		const pool = new SiteWriteLockPool({
			size: 1,
			reserveTimeoutMs: 30_000,
			createClient: () => fake.client,
		})
		const held = await pool.reserve()
		const controller = new AbortController()
		const waiting = pool.reserve(controller.signal)
		controller.abort()

		await expect(waiting).rejects.toThrow(/aborted/i)
		held.release()
		await pool.end({ timeout: 0 })
	})

	test('dispatches a queued waiter to the released slot', async () => {
		const created: FakePoolClient[] = []
		const pool = new SiteWriteLockPool({
			size: 1,
			reserveTimeoutMs: 100,
			createClient: () => {
				const fake = fakePoolClient()
				created.push(fake)
				return fake.client
			},
		})
		const first = await pool.reserve()
		const secondPromise = pool.reserve()
		let secondResolved = false
		void secondPromise.then(() => {
			secondResolved = true
		})
		await Promise.resolve()
		expect(secondResolved).toBe(false)

		first.release()
		const second = await secondPromise
		expect(secondResolved).toBe(true)
		second.release()
		await pool.end({ timeout: 0 })
		expect(created[0]?.reserveCalls).toBe(2)
	})

	test('rejects queued and new reservations after pool end', async () => {
		const pool = new SiteWriteLockPool({ size: 1, createClient: () => fakePoolClient().client })
		const held = await pool.reserve()
		const waiting = pool.reserve()
		const ended = pool.end({ timeout: 0 })

		await expect(waiting).rejects.toThrow('Site write lock pool is closed')
		await expect(pool.reserve()).rejects.toThrow('Site write lock pool is closed')
		await ended
		held.release()
	})

	test('keeps the forwarding wrapper usable while a reserved slot is idle', async () => {
		const fake = fakePoolClient()
		const pool = new SiteWriteLockPool({ size: 1, createClient: () => fake.client })
		const connection = await pool.reserve()
		await new Promise((resolve) => setTimeout(resolve, 2))
		await connection`SELECT 1`

		expect(connection).not.toBe(fake.client)
		expect(connection).not.toBe(fake.reserved)
		connection.release()
		await pool.end({ timeout: 0 })
		expect(fake.releaseCalls).toBe(1)
	})

	test('propagates client end rejection while refusing future reservations', async () => {
		const endError = new Error('end failed')
		const fake = fakePoolClient({ endError })
		const pool = new SiteWriteLockPool({ size: 1, createClient: () => fake.client })
		await pool.reserve()

		await expect(pool.end({ timeout: 0 })).rejects.toBe(endError)
		await expect(pool.reserve()).rejects.toThrow('Site write lock pool is closed')
	})

	test('uses a positive production reserve timeout', () => {
		expect(LOCK_POOL_RESERVE_TIMEOUT_MS).toBeGreaterThan(0)
	})
})
