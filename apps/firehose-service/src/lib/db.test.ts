import { beforeEach, describe, expect, test } from 'bun:test'
import {
	LOCK_ACQUIRE_LOCK_TIMEOUT,
	LOCK_HEARTBEAT_INTERVAL_MS,
	LOCK_HEARTBEAT_TIMEOUT_MS,
	LOCK_POOL_RESERVE_TIMEOUT_MS,
	LOCK_POOL_RETIRE_TIMEOUT_SECONDS,
	SiteWriteLockAcquisitionError,
	type SiteWriteLockConnection,
	SiteWriteLockLostError,
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
		// Keep the literal in step with LOCK_ACQUIRE_LOCK_TIMEOUT.
		expect(commands).toContain(`SET lock_timeout = '${LOCK_ACQUIRE_LOCK_TIMEOUT}'`)
		expect(LOCK_ACQUIRE_LOCK_TIMEOUT).toBe('45s')
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
		const cancellableCloseOptions: Array<{ timeout: number }> = []
		cancellableConnection.close = async (options) => {
			closeCalls += 1
			cancellableCloseOptions.push(options)
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
		expect(cancellableCloseOptions).toEqual([{ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }])
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
		expect(closeOptions).toEqual([{ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }])
	})

	test('quarantines a connection when advisory unlock returns false', async () => {
		unlockResult = [{ unlocked: false }]

		await expect(withReservedSiteWriteLock(connection, 'did:plc:test', 'site', async () => 'written')).resolves.toBe(
			'written',
		)

		expect(releases).toBe(0)
		expect(closes).toBe(1)
		expect(closeOptions).toEqual([{ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }])
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
		expect(closeOptions).toEqual([{ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }])
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

describe('lock session heartbeat and fencing', () => {
	test('probes the session while the callback runs and unlocks normally afterwards', async () => {
		const probes: string[] = []
		const heartbeatConnection = ((strings: TemplateStringsArray) => {
			const command = strings.join('?')
			commands.push(command)
			if (command.includes('SELECT 1')) probes.push(command)
			return Promise.resolve([])
		}) as unknown as SiteWriteLockConnection
		heartbeatConnection.release = () => {}
		heartbeatConnection.close = async () => {}

		await withReservedSiteWriteLock(
			heartbeatConnection,
			'did:plc:test',
			'site',
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 25))
				return 'written'
			},
			undefined,
			{ intervalMs: 5, timeoutMs: 250 },
		)

		expect(probes.length).toBeGreaterThanOrEqual(2)
		expect(commands.some((command) => command.includes('pg_advisory_unlock'))).toBe(true)
	})

	test('a failed probe aborts the callback, skips unlock, and quarantines the session', async () => {
		unlockResult = [{ unlocked: true }]
		const heartbeatConnection = ((strings: TemplateStringsArray) => {
			const command = strings.join('?')
			commands.push(command)
			if (command.includes('SELECT 1')) return Promise.reject(new Error('session was idle-killed'))
			return Promise.resolve(command.includes('pg_advisory_unlock') ? unlockResult : [])
		}) as unknown as SiteWriteLockConnection
		heartbeatConnection.release = () => {
			releases += 1
		}
		heartbeatConnection.close = async (options) => {
			closes += 1
			closeOptions.push(options)
		}

		let observedAbort: string | undefined
		const thrown = await withReservedSiteWriteLock(
			heartbeatConnection,
			'did:plc:test',
			'site',
			async (signal) => {
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve()
					else signal.addEventListener('abort', () => resolve(), { once: true })
				})
				observedAbort = signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
				throw new Error('fenced download stopped')
			},
			undefined,
			{ intervalMs: 5, timeoutMs: 250 },
		).then(
			(value) => ({ resolved: value }),
			(error: unknown) => ({ rejected: error }),
		)

		// The callback that honors the fencing signal surfaces its own error; the
		// lock loss is observable on the signal it received.
		expect('rejected' in thrown ? thrown.rejected : new Error('expected rejection')).toBeInstanceOf(Error)
		expect(observedAbort).toBe('session was idle-killed')
		// Never unlock or reuse a session whose lock is already gone server-side.
		expect(commands.some((command) => command.includes('pg_advisory_unlock'))).toBe(false)
		expect(releases).toBe(0)
		expect(closes).toBe(1)
		expect(closeOptions).toEqual([{ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }])
	})

	test('a callback that ignores the fencing signal still fails with SiteWriteLockLostError', async () => {
		const heartbeatConnection = ((strings: TemplateStringsArray) => {
			const command = strings.join('?')
			if (command.includes('SELECT 1')) return Promise.reject(new Error('proxy closed the session'))
			return Promise.resolve([])
		}) as unknown as SiteWriteLockConnection
		heartbeatConnection.release = () => {}
		heartbeatConnection.close = async () => {}

		let thrown: unknown
		try {
			await withReservedSiteWriteLock(
				heartbeatConnection,
				'did:plc:test',
				'site',
				async () => {
					// Ignores the signal: keeps "downloading" past the lock loss.
					await new Promise((resolve) => setTimeout(resolve, 60))
					return 'written-unfenced'
				},
				undefined,
				{ intervalMs: 5, timeoutMs: 250 },
			)
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(SiteWriteLockLostError)
		const lostError = thrown as SiteWriteLockLostError
		expect(lostError.name).toBe('SiteWriteLockLostError')
		expect(lostError.message).toBe('Site write lock session was lost while the callback ran')
		expect(lostError.errorKind).toBe('Error')
	})

	test('a heartbeat timeout also presumes the lock lost', async () => {
		const heartbeatConnection = ((strings: TemplateStringsArray) => {
			const command = strings.join('?')
			if (command.includes('SELECT 1')) return new Promise(() => {})
			return Promise.resolve([])
		}) as unknown as SiteWriteLockConnection
		heartbeatConnection.release = () => {}
		heartbeatConnection.close = async () => {}

		let thrown: unknown
		try {
			await withReservedSiteWriteLock(
				heartbeatConnection,
				'did:plc:test',
				'site',
				async () => await new Promise((resolve) => setTimeout(resolve, 500)),
				undefined,
				{ intervalMs: 5, timeoutMs: 15 },
			)
		} catch (error) {
			thrown = error
		}

		expect(thrown).toBeInstanceOf(SiteWriteLockLostError)
		expect((thrown as SiteWriteLockLostError).errorKind).toBe('Error')
	})

	test('caller abort during the callback still unlocks and releases normally', async () => {
		const controller = new AbortController()
		const heartbeatConnection = ((strings: TemplateStringsArray) => {
			const command = strings.join('?')
			commands.push(command)
			return Promise.resolve(command.includes('pg_advisory_unlock') ? [{ unlocked: true }] : [])
		}) as unknown as SiteWriteLockConnection
		heartbeatConnection.release = () => {
			releases += 1
		}
		heartbeatConnection.close = async (options) => {
			closes += 1
			closeOptions.push(options)
		}

		const processing = withReservedSiteWriteLock(
			heartbeatConnection,
			'did:plc:test',
			'site',
			async (signal) => {
				await new Promise((resolve) => setTimeout(resolve, 500))
				return signal.aborted ? 'aborted-wait' : 'waited'
			},
			controller.signal,
			{ intervalMs: 5, timeoutMs: 250 },
		).then(
			(value) => ({ resolved: value }),
			(error: unknown) => ({ rejected: error }),
		)
		await new Promise((resolve) => setTimeout(resolve, 12))
		controller.abort()
		const outcome = await processing

		// The callback kept its promise; the wrapper unlocked and released the
		// session that the heartbeat had proven alive.
		expect(outcome).toEqual({ resolved: 'aborted-wait' })
		expect(commands.some((command) => command.includes('pg_advisory_unlock'))).toBe(true)
		expect(releases).toBe(1)
		expect(closes).toBe(0)
	})

	test('uses safe production heartbeat and retirement defaults', () => {
		expect(LOCK_ACQUIRE_LOCK_TIMEOUT).toBe('45s')
		expect(LOCK_POOL_RETIRE_TIMEOUT_SECONDS).toBeGreaterThan(0)
		expect(LOCK_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0)
		// Proxies idle-kill sessions at 60s; stay well below that bound.
		expect(LOCK_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(30_000)
		expect(LOCK_HEARTBEAT_TIMEOUT_MS).toBeGreaterThan(0)
		expect(LOCK_HEARTBEAT_TIMEOUT_MS).toBeLessThan(60_000)
	})
})

describe('SiteWriteLockPool retirement safety', () => {
	test('aborting an in-flight activation retires the client once with a bounded positive timeout', async () => {
		const fake = fakePoolClient({ reserve: new Promise<SiteWriteLockReservedClient>(() => {}) })
		const pool = new SiteWriteLockPool({ size: 1, createClient: () => fake.client })
		const controller = new AbortController()
		const waiting = pool.reserve(controller.signal)
		queueMicrotask(() => controller.abort())

		await expect(waiting).rejects.toThrow(/aborted/i)
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(fake.endCalls).toEqual([{ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }])
	})

	test('a reserve timeout retires the client with a bounded positive timeout', async () => {
		const fake = fakePoolClient({ reserve: new Promise<SiteWriteLockReservedClient>(() => {}) })
		const pool = new SiteWriteLockPool({
			size: 1,
			reserveTimeoutMs: 5,
			createClient: () => fake.client,
		})

		await expect(pool.reserve()).rejects.toThrow('Timed out reserving site write lock connection')
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(fake.endCalls).toEqual([{ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }])
	})

	test('a release failure quarantines the slot and later reservations get a fresh client', async () => {
		const created: FakePoolClient[] = []
		const pool = new SiteWriteLockPool({
			size: 1,
			createClient: () => {
				const fake = fakePoolClient()
				created.push(fake)
				return fake.client
			},
		})
		const first = await pool.reserve()
		created[0]!.reserved.release = () => {
			throw new Error('release exploded')
		}
		first.release()
		await new Promise((resolve) => setTimeout(resolve, 10))

		// The quarantined root client is ended exactly once with the safe bound.
		expect(created[0]?.endCalls).toEqual([{ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }])

		// The retired slot must never be handed out again.
		const second = await pool.reserve()
		expect(created.length).toBe(2)
		expect(created[0]?.reserveCalls).toBe(1)
		expect(created[1]?.reserveCalls).toBe(1)
		second.release()
		await pool.end({ timeout: 5 })
		expect(created[0]?.endCalls).toHaveLength(1)
		expect(created[1]?.endCalls).toEqual([{ timeout: 5 }])
	})

	test('pool end is bounded, idempotent, ends every client once, and forbids new reservations', async () => {
		const created: FakePoolClient[] = []
		const pool = new SiteWriteLockPool({
			size: 3,
			createClient: () => {
				const fake = fakePoolClient()
				created.push(fake)
				return fake.client
			},
		})
		const held = [await pool.reserve(), await pool.reserve(), await pool.reserve()]
		const ended = pool.end({ timeout: 5 })
		const endedAgain = pool.end({ timeout: 5 })

		expect(endedAgain).toBe(ended)
		await ended
		expect(created).toHaveLength(3)
		for (const fake of created) expect(fake.endCalls).toEqual([{ timeout: 5 }])
		for (const connection of held) connection.release()
		await expect(pool.reserve()).rejects.toThrow('Site write lock pool is closed')
	})
})

describe('lock lifecycle process survival (real postgres.js)', () => {
	interface SpawnResult {
		exitCode: number | null
		stdout: string
	}

	function runFixture(scenario: string, timeoutMs: number): Promise<SpawnResult> {
		return new Promise<SpawnResult>((resolve, reject) => {
			const child = Bun.spawn([process.execPath, `${import.meta.dir}/db.process-survival.fixture.ts`, scenario], {
				stdout: 'pipe',
				stderr: 'pipe',
				env: { ...process.env, NODE_ENV: 'test' },
			})
			const timer = setTimeout(() => {
				child.kill()
				reject(new Error(`fixture ${scenario} timed out after ${timeoutMs}ms`))
			}, timeoutMs)
			void Promise.all([new Response(child.stdout).text(), child.exited]).then(([stdout, exitCode]) => {
				clearTimeout(timer)
				resolve({ exitCode, stdout })
			})
		})
	}

	test('happy path: heartbeat, unlock, and pool end exit cleanly', async () => {
		const result = await runFixture('happy', 20_000)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('CALLBACK-OK written')
		expect(result.stdout).toContain('SURVIVED')
		expect(result.stdout).not.toContain('UNCAUGHT')
	})

	test('proxy idle-kill mid-callback fences and exits cleanly instead of crashing', async () => {
		const result = await runFixture('haproxy-kill', 20_000)
		expect(result.exitCode).toBe(0)
		// The callback must not report success once the lock session died.
		expect(result.stdout).not.toContain('CALLBACK-OK')
		expect(result.stdout).toMatch(/CALLBACK-ERROR (fenced|SiteWriteLockLostError)/)
		expect(result.stdout).toContain('SURVIVED')
		expect(result.stdout).not.toContain('UNCAUGHT')
	})

	test('cancel-and-close abort path exits cleanly', async () => {
		const result = await runFixture('abort', 20_000)
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('ACQUISITION-ERROR')
		expect(result.stdout).toContain('SURVIVED')
		expect(result.stdout).not.toContain('UNCAUGHT')
	})
})
