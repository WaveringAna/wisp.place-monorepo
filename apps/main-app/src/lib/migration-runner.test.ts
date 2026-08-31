import { describe, expect, test } from 'bun:test'
import {
	createRecordedMigrationRunner,
	type MigrationLedgerStore,
	MigrationLockCleanupError,
	MigrationStepError,
	type ReservedMigrationConnection,
	runMigrationStep,
	runMigrationStepsSequentially,
	sanitizeMigrationStartupError,
	withReservedMigrationAdvisoryLock,
} from './migration-runner'

function createConnection(
	calls: string[],
	options: { acquireFails?: boolean; resetFails?: boolean; unlockFails?: boolean; closeFails?: boolean } = {},
): ReservedMigrationConnection {
	return {
		async setLockTimeout() {
			calls.push('set-lock-timeout')
		},
		async acquireLock() {
			calls.push('acquire-lock')
			if (options.acquireFails) throw { code: '55P03', message: 'postgres://secret@primary/wisp' }
		},
		async resetLockTimeout() {
			calls.push('reset-lock-timeout')
			if (options.resetFails) throw { code: '08006', message: 'postgres://secret@primary/wisp' }
		},
		async unlock() {
			calls.push('unlock')
			if (options.unlockFails) throw { code: '08006', message: 'postgres://secret@primary/wisp' }
		},
		release() {
			calls.push('release')
		},
		async close() {
			calls.push('close')
			if (options.closeFails) throw { code: '08006', message: 'postgres://secret@primary/wisp' }
		},
	}
}

class InMemoryMigrationLedgerStore implements MigrationLedgerStore<undefined> {
	readonly appliedNames = new Set<string>()
	loadCalls = 0
	private transactionTail = Promise.resolve()

	async loadAppliedNames(): Promise<ReadonlySet<string>> {
		this.loadCalls++
		return new Set(this.appliedNames)
	}

	async transaction(
		operation: (transaction: {
			connection: undefined
			isMigrationApplied(name: string): Promise<boolean>
			recordMigration(name: string): Promise<void>
		}) => Promise<void>,
	): Promise<void> {
		const previous = this.transactionTail
		let release: (() => void) | undefined
		this.transactionTail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous

		const recordedNames = new Set<string>()
		try {
			await operation({
				connection: undefined,
				isMigrationApplied: async (name: string): Promise<boolean> => this.appliedNames.has(name),
				recordMigration: async (name: string): Promise<void> => {
					recordedNames.add(name)
				},
			})
			for (const name of recordedNames) this.appliedNames.add(name)
		} finally {
			release?.()
		}
	}
}

describe('migration runner', () => {
	test('runs migration steps serially', async () => {
		const calls: string[] = []
		let firstFinished = false

		await runMigrationStepsSequentially([
			{
				name: 'first',
				async run() {
					calls.push('first-start')
					await Promise.resolve()
					firstFinished = true
					calls.push('first-end')
				},
			},
			{
				name: 'second',
				async run() {
					expect(firstFinished).toBe(true)
					calls.push('second')
				},
			},
		])

		expect(calls).toEqual(['first-start', 'first-end', 'second'])
	})

	test('surfaces a duplicate-object SQLSTATE without the driver message', async () => {
		try {
			await runMigrationStep({
				name: 'duplicate constraint',
				async run() {
					throw {
						code: 'ERR_POSTGRES_SERVER_ERROR',
						errno: '42710',
						message: 'postgres://secret@primary/wisp already exists',
					}
				},
			})
			throw new Error('expected migration failure')
		} catch (error) {
			expect(error).toBeInstanceOf(MigrationStepError)
			expect((error as Error).message).toContain('SQLSTATE 42710')
			expect((error as Error).message).not.toContain('postgres://')
		}
	})

	test('releases a healthy reserved connection after unlocking', async () => {
		const calls: string[] = []
		const value = await withReservedMigrationAdvisoryLock(createConnection(calls), async () => {
			calls.push('migrations')
			return 'ready'
		})

		expect(value).toBe('ready')
		expect(calls).toEqual(['set-lock-timeout', 'acquire-lock', 'reset-lock-timeout', 'migrations', 'unlock', 'release'])
	})

	test('unlocks then closes a reserved session when resetting lock_timeout fails', async () => {
		const calls: string[] = []
		try {
			await withReservedMigrationAdvisoryLock(createConnection(calls, { resetFails: true }), async () => {
				throw new Error('migration body must not run')
			})
			throw new Error('expected reset failure')
		} catch (error) {
			const safeError = sanitizeMigrationStartupError('advisory lock', error)
			expect(safeError.message).toContain('SQLSTATE 08006')
			expect(safeError.message).not.toContain('postgres://')
		}

		expect(calls).toEqual(['set-lock-timeout', 'acquire-lock', 'reset-lock-timeout', 'unlock', 'close'])
	})

	test('unlocks and releases after a migration callback failure', async () => {
		const calls: string[] = []
		await expect(
			withReservedMigrationAdvisoryLock(createConnection(calls), async () => {
				calls.push('migrations')
				throw new MigrationStepError('test migration', '22000')
			}),
		).rejects.toBeInstanceOf(MigrationStepError)

		expect(calls).toEqual(['set-lock-timeout', 'acquire-lock', 'reset-lock-timeout', 'migrations', 'unlock', 'release'])
	})

	test('quarantines and closes a connection when advisory unlock fails', async () => {
		const calls: string[] = []
		const cleanupFailures: string[] = []

		await expect(
			withReservedMigrationAdvisoryLock(
				createConnection(calls, { unlockFails: true }),
				async () => {
					calls.push('migrations')
				},
				(kind) => cleanupFailures.push(kind),
			),
		).rejects.toBeInstanceOf(MigrationLockCleanupError)

		expect(calls).toEqual(['set-lock-timeout', 'acquire-lock', 'reset-lock-timeout', 'migrations', 'unlock', 'close'])
		expect(cleanupFailures).toEqual(['unlock'])
	})

	test('sanitizes lock setup failures without retaining driver messages', async () => {
		const calls: string[] = []
		try {
			await withReservedMigrationAdvisoryLock(createConnection(calls, { acquireFails: true }), async () => {})
			throw new Error('expected lock failure')
		} catch (error) {
			const safeError = sanitizeMigrationStartupError('advisory lock', error)
			expect(safeError.message).toContain('SQLSTATE 55P03')
			expect(safeError.message).not.toContain('postgres://')
		}

		expect(calls).toEqual(['set-lock-timeout', 'acquire-lock', 'close'])
	})

	test('rolls back an interrupted step and retries it without a ledger row', async () => {
		const store = new InMemoryMigrationLedgerStore()
		const runner = await createRecordedMigrationRunner(store)
		let attempts = 0
		const step = {
			name: '001-interrupted-step',
			async run(): Promise<void> {
				attempts++
				if (attempts === 1) throw new Error('interrupted')
			},
		}

		await expect(runner.run(step)).rejects.toBeInstanceOf(MigrationStepError)
		expect(store.appliedNames.has(step.name)).toBe(false)
		await runner.run(step)
		expect({ attempts, applied: store.appliedNames.has(step.name) }).toEqual({ attempts: 2, applied: true })
	})

	test('skips a migration recorded by an earlier startup', async () => {
		const store = new InMemoryMigrationLedgerStore()
		let runs = 0
		const step = {
			name: '002-once-only',
			async run(): Promise<void> {
				runs++
			},
		}

		await (await createRecordedMigrationRunner(store)).run(step)
		await (await createRecordedMigrationRunner(store)).run(step)
		expect(runs).toBe(1)
	})

	test('loads the ledger once and skips all recorded work on a restart', async () => {
		const store = new InMemoryMigrationLedgerStore()
		store.appliedNames.add('004-recorded-one')
		store.appliedNames.add('005-recorded-two')
		const runner = await createRecordedMigrationRunner(store)
		let runs = 0

		await runner.runAll([
			{ name: '004-recorded-one', run: async () => void runs++ },
			{ name: '005-recorded-two', run: async () => void runs++ },
		])

		expect({ loadCalls: store.loadCalls, runs }).toEqual({ loadCalls: 1, runs: 0 })
	})

	test('allows only one concurrent startup to apply a named migration', async () => {
		const store = new InMemoryMigrationLedgerStore()
		const [first, second] = await Promise.all([
			createRecordedMigrationRunner(store),
			createRecordedMigrationRunner(store),
		])
		let runs = 0
		const step = {
			name: '003-concurrent-startup',
			async run(): Promise<void> {
				runs++
				await Promise.resolve()
			},
		}

		await Promise.all([first.run(step), second.run(step)])
		expect({ runs, applied: store.appliedNames.has(step.name) }).toEqual({ runs: 1, applied: true })
	})
})
