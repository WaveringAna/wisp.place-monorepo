import { describe, expect, test } from 'bun:test'
import { config } from '../config'
import {
	boundedCursorFromStoredValue,
	type CursorRedisClient,
	DELETE_MIGRATED_CURSOR_SCRIPT,
	isValidCursor,
	type LeaderElectionDependencies,
	legacyCursorKey,
	MIGRATE_CURSOR_SCRIPT,
	parseStoredCursor,
	readDurableCursorWithRedis,
	relayFingerprint,
	runLeaderElection,
	SAVE_CURSOR_SCRIPT,
	shouldAdvanceStoredCursor,
} from './leader'

describe('stored leader cursors', () => {
	test('accepts only nonnegative decimal safe integers', () => {
		expect(parseStoredCursor('0')).toBe(0)
		expect(parseStoredCursor('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
		expect(isValidCursor(42)).toBe(true)

		for (const value of ['-1', '+1', '1.5', '1e3', ' 1', '9007199254740992', 'not-a-number']) {
			expect(parseStoredCursor(value)).toBeUndefined()
			expect(boundedCursorFromStoredValue(value)).toBeUndefined()
		}
		expect(boundedCursorFromStoredValue(null)).toBeUndefined()
		expect(isValidCursor(-1)).toBe(false)
		expect(isValidCursor(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
	})

	test('keeps a relay cursor monotonic and repairs corrupt stored values', () => {
		expect(shouldAdvanceStoredCursor('41', 42)).toBe(true)
		expect(shouldAdvanceStoredCursor('42', 42)).toBe(false)
		expect(shouldAdvanceStoredCursor('43', 42)).toBe(false)
		expect(shouldAdvanceStoredCursor('corrupt', 42)).toBe(true)
		expect(shouldAdvanceStoredCursor(null, 42)).toBe(true)
		expect(shouldAdvanceStoredCursor('1', -1)).toBe(false)
	})

	test('derives the exact same-relay legacy checkpoint key without credentials', () => {
		expect(legacyCursorKey('wss://user:secret@relay.example.invalid:443/path?token=secret')).toBe(
			'wisp:firehose-cursor:relay.example.invalid',
		)
		expect(legacyCursorKey('not a URL')).toBeUndefined()
	})

	test('keeps legacy host compatibility while separating hashed relay paths', () => {
		const first = 'wss://relay.example.invalid/first'
		const second = 'wss://relay.example.invalid/second'

		expect(legacyCursorKey(first)).toBe(legacyCursorKey(second))
		expect(relayFingerprint(first)).not.toBe(relayFingerprint(second))
	})

	test('uses a normalized non-secret relay fingerprint', () => {
		const clean = relayFingerprint('wss://relay.example.invalid/path')
		const credentialed = relayFingerprint('wss://user:secret@relay.example.invalid/path?token=secret')

		expect(clean).toBe(credentialed)
		expect(clean).toMatch(/^[a-f0-9]{64}$/)
		expect(clean).not.toContain('relay.example')
		expect(clean).not.toContain('secret')
	})
})

const MIGRATION_SERVICE = 'wss://relay.example.invalid'
const MIGRATION_HASHED_KEY = `wisp:firehose-cursor:${relayFingerprint(MIGRATION_SERVICE)}`
const MIGRATION_LEGACY_KEY = legacyCursorKey(MIGRATION_SERVICE) as string
const AMBIGUOUS_SERVICE = 'wss://relay.example.invalid/independent'
const AMBIGUOUS_HASHED_KEY = `wisp:firehose-cursor:${relayFingerprint(AMBIGUOUS_SERVICE)}`
const AMBIGUOUS_LEGACY_KEY = legacyCursorKey(AMBIGUOUS_SERVICE) as string

type EvalCall = { script: string; keyCount: number; args: Array<string | number> }

class FakeCursorRedis implements CursorRedisClient {
	readonly values = new Map<string, string>()
	readonly getCalls: string[] = []
	readonly evalCalls: EvalCall[] = []
	migrationFailure: Error | undefined
	deletionFailure: Error | undefined
	beforeHashedRead: (() => void) | undefined
	beforeDeletion: (() => void) | undefined

	async get(key: string): Promise<string | null> {
		this.getCalls.push(key)
		if (key === MIGRATION_HASHED_KEY && this.beforeHashedRead) {
			const hook = this.beforeHashedRead
			this.beforeHashedRead = undefined
			hook()
		}
		return this.values.get(key) ?? null
	}

	async eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown> {
		this.evalCalls.push({ script, keyCount, args })
		if (script === SAVE_CURSOR_SCRIPT) {
			const [key, nextValue] = args
			if (typeof key !== 'string' || typeof nextValue !== 'string') throw new Error('invalid fake save args')
			const current = parseStoredCursor(this.values.get(key) ?? null)
			const next = parseStoredCursor(nextValue)
			if (next === undefined) throw new Error('invalid fake cursor')
			if (current !== undefined && current >= next) return 0
			this.values.set(key, nextValue)
			return 1
		}
		if (script === MIGRATE_CURSOR_SCRIPT) {
			if (this.migrationFailure) throw this.migrationFailure
			const [hashedKey, legacyKey] = args
			if (typeof hashedKey !== 'string' || typeof legacyKey !== 'string') throw new Error('invalid fake keys')
			const currentValue = this.values.get(hashedKey)
			const current = parseStoredCursor(currentValue ?? null)
			const legacy = parseStoredCursor(this.values.get(legacyKey) ?? null)
			if (legacy === undefined) return [0, currentValue ?? '']
			const selected = current !== undefined && current >= legacy ? current : legacy
			if (current === undefined || current !== selected) this.values.set(hashedKey, String(selected))
			return [1, String(selected)]
		}
		if (script === DELETE_MIGRATED_CURSOR_SCRIPT) {
			if (this.deletionFailure) throw this.deletionFailure
			this.beforeDeletion?.()
			this.beforeDeletion = undefined
			const [hashedKey, legacyKey, expectedValue] = args
			if (typeof hashedKey !== 'string' || typeof legacyKey !== 'string' || typeof expectedValue !== 'string') {
				throw new Error('invalid fake deletion args')
			}
			const current = parseStoredCursor(this.values.get(hashedKey) ?? null)
			const legacy = parseStoredCursor(this.values.get(legacyKey) ?? null)
			const expected = parseStoredCursor(expectedValue)
			if (current === undefined) return -2
			if (expected === undefined) return -4
			if (legacy !== undefined && current < legacy) return -3
			if (current < expected) return -4
			if (!this.values.has(legacyKey)) return 0
			if (legacy === undefined) return -1
			this.values.delete(legacyKey)
			return 1
		}
		throw new Error('unknown fake script')
	}
}

describe('atomic cursor saves', () => {
	test('repairs a stored decimal above Number.MAX_SAFE_INTEGER', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_HASHED_KEY, '9007199254740992')

		await redis.eval(SAVE_CURSOR_SCRIPT, 1, MIGRATION_HASHED_KEY, '42')

		expect(redis.values.get(MIGRATION_HASHED_KEY)).toBe('42')
	})
})

describe('same-relay cursor migration', () => {
	test('atomically migrates, re-reads, and removes the legacy key', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_LEGACY_KEY, '41')

		const result = await readDurableCursorWithRedis(redis, MIGRATION_SERVICE)

		expect(result).toEqual({ read: { kind: 'found', cursor: 41 }, migrated: true, corrupt: false })
		expect(redis.values.get(MIGRATION_HASHED_KEY)).toBe('41')
		expect(redis.values.has(MIGRATION_LEGACY_KEY)).toBe(false)
		expect(redis.getCalls).toEqual([MIGRATION_HASHED_KEY])
		expect(redis.evalCalls.map(({ script }) => script)).toEqual([MIGRATE_CURSOR_SCRIPT, DELETE_MIGRATED_CURSOR_SCRIPT])
		expect(redis.evalCalls[1]?.args).toEqual([MIGRATION_HASHED_KEY, MIGRATION_LEGACY_KEY, '41'])
	})

	test('keeps a newer hashed cursor and still removes the older legacy key', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_HASHED_KEY, '80')
		redis.values.set(MIGRATION_LEGACY_KEY, '41')

		const result = await readDurableCursorWithRedis(redis, MIGRATION_SERVICE)

		expect(result.read).toEqual({ kind: 'found', cursor: 80 })
		expect(redis.values.has(MIGRATION_LEGACY_KEY)).toBe(false)
		expect(redis.evalCalls[1]?.args).toEqual([MIGRATION_HASHED_KEY, MIGRATION_LEGACY_KEY, '80'])
	})

	test('returns missing and preserves a malformed legacy value', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_LEGACY_KEY, 'not-a-cursor')

		const result = await readDurableCursorWithRedis(redis, MIGRATION_SERVICE)

		expect(result).toEqual({ read: { kind: 'missing' }, migrated: false, corrupt: false })
		expect(redis.values.get(MIGRATION_LEGACY_KEY)).toBe('not-a-cursor')
		expect(redis.evalCalls).toHaveLength(1)
	})

	test('does not delete malformed legacy data when the hashed key is valid', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_HASHED_KEY, '80')
		redis.values.set(MIGRATION_LEGACY_KEY, 'not-a-cursor')

		const result = await readDurableCursorWithRedis(redis, MIGRATION_SERVICE)

		expect(result.read).toEqual({ kind: 'found', cursor: 80 })
		expect(redis.values.get(MIGRATION_LEGACY_KEY)).toBe('not-a-cursor')
		expect(redis.evalCalls).toHaveLength(1)
	})

	test('fails closed and keeps the legacy value when migration cannot run', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_LEGACY_KEY, '41')
		redis.migrationFailure = new Error('migration unavailable')

		await expect(readDurableCursorWithRedis(redis, MIGRATION_SERVICE)).rejects.toThrow('migration unavailable')
		expect(redis.values.has(MIGRATION_HASHED_KEY)).toBe(false)
		expect(redis.values.get(MIGRATION_LEGACY_KEY)).toBe('41')
	})

	test('fails closed and keeps the legacy value when deletion cannot run', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_LEGACY_KEY, '41')
		redis.deletionFailure = new Error('deletion unavailable')

		await expect(readDurableCursorWithRedis(redis, MIGRATION_SERVICE)).rejects.toThrow('deletion unavailable')
		expect(redis.values.get(MIGRATION_HASHED_KEY)).toBe('41')
		expect(redis.values.get(MIGRATION_LEGACY_KEY)).toBe('41')
	})

	test('returns the newer hashed cursor when it wins during the re-read', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_LEGACY_KEY, '41')
		redis.beforeHashedRead = () => redis.values.set(MIGRATION_HASHED_KEY, '77')

		const result = await readDurableCursorWithRedis(redis, MIGRATION_SERVICE)

		expect(result.read).toEqual({ kind: 'found', cursor: 77 })
		expect(redis.values.has(MIGRATION_LEGACY_KEY)).toBe(false)
	})

	test('retries when a newer legacy value wins the delete race', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_LEGACY_KEY, '41')
		let raced = false
		redis.beforeDeletion = () => {
			if (!raced) {
				raced = true
				redis.values.set(MIGRATION_LEGACY_KEY, '80')
			}
		}

		const result = await readDurableCursorWithRedis(redis, MIGRATION_SERVICE)

		expect(result.read).toEqual({ kind: 'found', cursor: 80 })
		expect(redis.values.get(MIGRATION_HASHED_KEY)).toBe('80')
		expect(redis.values.has(MIGRATION_LEGACY_KEY)).toBe(false)
		expect(redis.evalCalls.map(({ script }) => script)).toEqual([
			MIGRATE_CURSOR_SCRIPT,
			DELETE_MIGRATED_CURSOR_SCRIPT,
			MIGRATE_CURSOR_SCRIPT,
			DELETE_MIGRATED_CURSOR_SCRIPT,
		])
	})

	test('keeps the legacy value when the hashed value becomes malformed after migration', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_LEGACY_KEY, '41')
		redis.beforeHashedRead = () => redis.values.set(MIGRATION_HASHED_KEY, 'corrupt')

		await expect(readDurableCursorWithRedis(redis, MIGRATION_SERVICE)).rejects.toThrow('legacy migration was confirmed')
		expect(redis.values.get(MIGRATION_LEGACY_KEY)).toBe('41')
	})

	test('does not trust a stale re-read if both keys disappear before deletion', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(MIGRATION_LEGACY_KEY, '41')
		redis.beforeDeletion = () => {
			redis.values.delete(MIGRATION_HASHED_KEY)
			redis.values.delete(MIGRATION_LEGACY_KEY)
		}

		await expect(readDurableCursorWithRedis(redis, MIGRATION_SERVICE)).rejects.toThrow('legacy migration was confirmed')
	})
	test('fails closed instead of importing an ambiguous non-root legacy cursor', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(AMBIGUOUS_LEGACY_KEY, '41')

		await expect(readDurableCursorWithRedis(redis, AMBIGUOUS_SERVICE)).rejects.toThrow(/preseed .*correct checkpoint/i)
		expect(redis.values.has(AMBIGUOUS_HASHED_KEY)).toBe(false)
		expect(redis.values.get(AMBIGUOUS_LEGACY_KEY)).toBe('41')
		expect(redis.evalCalls).toHaveLength(0)
	})

	test('fails closed when a corrupt path cursor meets an ambiguous legacy cursor', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(AMBIGUOUS_HASHED_KEY, 'corrupt')
		redis.values.set(AMBIGUOUS_LEGACY_KEY, '41')

		await expect(readDurableCursorWithRedis(redis, AMBIGUOUS_SERVICE)).rejects.toThrow(/ambiguous legacy cursor/i)
		expect(redis.values.get(AMBIGUOUS_HASHED_KEY)).toBe('corrupt')
		expect(redis.values.get(AMBIGUOUS_LEGACY_KEY)).toBe('41')
	})

	test('does not consult or delete ambiguous legacy data when a path cursor is valid', async () => {
		const redis = new FakeCursorRedis()
		redis.values.set(AMBIGUOUS_HASHED_KEY, '80')
		redis.values.set(AMBIGUOUS_LEGACY_KEY, '41')

		const result = await readDurableCursorWithRedis(redis, AMBIGUOUS_SERVICE)

		expect(result).toEqual({ read: { kind: 'found', cursor: 80 }, migrated: false, corrupt: false })
		expect(redis.values.get(AMBIGUOUS_LEGACY_KEY)).toBe('41')
		expect(redis.getCalls).toEqual([AMBIGUOUS_HASHED_KEY])
	})
})

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function lifecycleDependencies(overrides: Partial<LeaderElectionDependencies> = {}): LeaderElectionDependencies {
	return {
		tryBecomeLeader: async () => true,
		renewLeadership: async () => true,
		releaseLeadership: async () => undefined,
		readCursor: async () => undefined,
		sleep: async (_ms, signal) => {
			if (signal.aborted) return
			await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
		},
		...overrides,
	}
}

describe('leader drain lifecycle', () => {
	test('keeps the lease until the drain-aware loss callback settles', async () => {
		const controller = new AbortController()
		const started = deferred<void>()
		const drain = deferred<boolean>()
		let stepDown: (() => Promise<void>) | undefined
		let receivedCursor: number | undefined = 42
		let releases = 0
		const election = runLeaderElection(
			(cursor, receivedStepDown) => {
				receivedCursor = cursor
				stepDown = receivedStepDown
				started.resolve()
			},
			async () => await drain.promise,
			controller.signal,
			'wss://relay.example.invalid',
			lifecycleDependencies({
				releaseLeadership: async () => {
					releases++
				},
			}),
		)

		await started.promise
		// A confirmed missing checkpoint starts live rather than being rewritten
		// as a synthetic zero cursor.
		expect(receivedCursor).toBeUndefined()
		const stopping = stepDown?.()
		expect(stopping).toBeDefined()
		await Promise.resolve()
		expect(releases).toBe(0)

		drain.resolve(true)
		await stopping
		expect(releases).toBe(1)
		controller.abort()
		await election
	})

	test('does not start relay work when the durable cursor read fails', async () => {
		const controller = new AbortController()
		let starts = 0
		let losses = 0
		let releases = 0
		const election = runLeaderElection(
			() => {
				starts++
			},
			async () => {
				losses++
				return true
			},
			controller.signal,
			'wss://relay.example.invalid',
			lifecycleDependencies({
				readCursor: async () => {
					throw new Error('cursor store unavailable')
				},
				releaseLeadership: async () => {
					releases++
				},
				sleep: async () => {
					controller.abort()
				},
			}),
		)

		await election
		expect(starts).toBe(0)
		expect(losses).toBe(1)
		expect(releases).toBe(1)
	})

	test('does not start stale leader work after the lease is lost during cursor read', async () => {
		const mutableConfig = config as unknown as {
			leaderTtlMs: number
			leaderRenewIntervalMs: number
			leaderPollIntervalMs: number
		}
		const originalConfig = { ...mutableConfig }
		Object.assign(mutableConfig, { leaderTtlMs: 110, leaderRenewIntervalMs: 1000, leaderPollIntervalMs: 5 })

		const controller = new AbortController()
		let fakeNow = 0
		const readStarted = deferred<void>()
		const readResult = deferred<number | undefined>()
		type ScheduledTimer = { callback: () => void; delay: number; cancelled: boolean }
		const timers: ScheduledTimer[] = []
		let starts = 0
		let losses = 0
		let releases = 0
		let election: Promise<void> | undefined
		try {
			election = runLeaderElection(
				() => {
					starts++
				},
				async () => {
					losses++
					controller.abort()
					return true
				},
				controller.signal,
				'wss://relay.example.invalid',
				lifecycleDependencies({
					readCursor: async () => {
						readStarted.resolve()
						return readResult.promise
					},
					releaseLeadership: async () => {
						releases++
					},
					now: () => fakeNow,
					setTimeout: (callback, delay) => {
						const timer: ScheduledTimer = { callback, delay, cancelled: false }
						timers.push(timer)
						return timer as unknown as ReturnType<typeof setTimeout>
					},
					clearTimeout: (timer) => {
						;(timer as unknown as ScheduledTimer).cancelled = true
					},
				}),
			)

			await readStarted.promise
			expect(timers[0]?.delay).toBe(10)
			fakeNow = 10
			timers[0]?.callback()
			expect(losses).toBe(1)
			readResult.resolve(42)
			await election
			expect(starts).toBe(0)
			expect(releases).toBe(0)
		} finally {
			readResult.resolve(undefined)
			controller.abort()
			await election?.catch(() => undefined)
			Object.assign(mutableConfig, originalConfig)
		}
	})

	test('does not release a lease after a forced drain result', async () => {
		const controller = new AbortController()
		const started = deferred<void>()
		let stepDown: (() => Promise<void>) | undefined
		let receivedCursor: number | undefined = 42
		let releases = 0
		const election = runLeaderElection(
			(cursor, receivedStepDown) => {
				receivedCursor = cursor
				stepDown = receivedStepDown
				started.resolve()
			},
			async () => false,
			controller.signal,
			'wss://relay.example.invalid',
			lifecycleDependencies({
				releaseLeadership: async () => {
					releases++
				},
			}),
		)

		await started.promise
		// A confirmed missing checkpoint starts live rather than being rewritten
		// as a synthetic zero cursor.
		expect(receivedCursor).toBeUndefined()
		await stepDown?.()
		expect(releases).toBe(0)
		await expect(election).rejects.toThrow('forced leadership drain')
		controller.abort()
	})
	test('fences a hung renewal at the monotonic lease safety deadline', async () => {
		const mutableConfig = config as unknown as {
			leaderTtlMs: number
			leaderRenewIntervalMs: number
			leaderPollIntervalMs: number
		}
		const originalConfig = { ...mutableConfig }
		Object.assign(mutableConfig, { leaderTtlMs: 400, leaderRenewIntervalMs: 25, leaderPollIntervalMs: 5 })

		const controller = new AbortController()
		const started = deferred<void>()
		const renewalStarted = deferred<void>()
		const hangingRenewal = deferred<boolean>()
		let fakeNow = 0
		let losses = 0
		let starts = 0
		let renewals = 0
		let election: Promise<void> | undefined
		try {
			election = runLeaderElection(
				() => {
					starts++
					if (starts === 1) started.resolve()
				},
				async () => {
					losses++
					return true
				},
				controller.signal,
				'wss://relay.example.invalid',
				lifecycleDependencies({
					renewLeadership: async () => {
						renewals++
						if (renewals === 1) {
							renewalStarted.resolve()
							return hangingRenewal.promise
						}
						controller.abort()
						return true
					},
					sleep: async (_ms, signal) => {
						await new Promise<void>((resolve) => setTimeout(resolve, 2))
						fakeNow += 10
						if (signal.aborted) return
					},
					now: () => fakeNow,
				}),
			)

			await started.promise
			await renewalStarted.promise
			await election
			expect(losses).toBe(2)
			expect(starts).toBe(2)
			expect(renewals).toBe(2)
			expect(fakeNow).toBeGreaterThanOrEqual(300)
		} finally {
			hangingRenewal.resolve(true)
			controller.abort()
			await election?.catch(() => undefined)
			Object.assign(mutableConfig, originalConfig)
		}
	})
})
