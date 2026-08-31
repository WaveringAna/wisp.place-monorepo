const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/

/** Extract only a validated PostgreSQL SQLSTATE; never inspect driver messages. */
export const sqlStateFromError = (error: unknown): string | undefined => {
	if (typeof error !== 'object' || error === null) return undefined

	// Bun maps PostgreSQL's five-character SQLSTATE to `errno` and keeps its
	// own runtime error identifier in `code`. Other drivers commonly use `code`.
	for (const value of [(error as { code?: unknown }).code, (error as { errno?: unknown }).errno]) {
		if (typeof value === 'string' && SQLSTATE_PATTERN.test(value)) return value
	}
	return undefined
}

export class MigrationStepError extends Error {
	readonly migration: string
	readonly sqlState: string | undefined

	constructor(migration: string, sqlState: string | undefined) {
		super(`Database migration "${migration}" failed${sqlState ? ` (SQLSTATE ${sqlState})` : ''}`)
		this.name = 'MigrationStepError'
		this.migration = migration
		this.sqlState = sqlState
	}
}

export class MigrationStartupError extends Error {
	readonly stage: string
	readonly sqlState: string | undefined

	constructor(stage: string, sqlState: string | undefined) {
		super(`Database migration startup failed during ${stage}${sqlState ? ` (SQLSTATE ${sqlState})` : ''}`)
		this.name = 'MigrationStartupError'
		this.stage = stage
		this.sqlState = sqlState
	}
}

export class MigrationLockCleanupError extends Error {
	constructor() {
		super('Database migration advisory-lock cleanup failed')
		this.name = 'MigrationLockCleanupError'
	}
}

export interface MigrationStep {
	name: string
	run(): Promise<unknown>
}

/** Wraps a step failure without retaining a driver message or connection URL. */
export const runMigrationStep = async (step: MigrationStep): Promise<void> => {
	try {
		await step.run()
	} catch (error) {
		throw new MigrationStepError(step.name, sqlStateFromError(error))
	}
}

/** Runs migration steps serially so dependent DDL and data cleanup cannot overlap. */
export const runMigrationStepsSequentially = async (steps: readonly MigrationStep[]): Promise<void> => {
	for (const step of steps) {
		await runMigrationStep(step)
	}
}

/** A migration whose SQL work must share a transaction with its ledger record. */
export interface RecordedMigrationStep<TConnection> {
	name: string
	run(connection: TConnection): Promise<unknown>
}

export interface MigrationLedgerTransaction<TConnection> {
	connection: TConnection
	/** Reads the durable ledger from inside the migration transaction. */
	isMigrationApplied(name: string): Promise<boolean>
	/** Records a completed migration in that same transaction. */
	recordMigration(name: string): Promise<void>
}

export interface MigrationLedgerStore<TConnection> {
	loadAppliedNames(): Promise<ReadonlySet<string>>
	transaction(operation: (transaction: MigrationLedgerTransaction<TConnection>) => Promise<void>): Promise<void>
}

export interface RecordedMigrationRunner<TConnection> {
	run(step: RecordedMigrationStep<TConnection>): Promise<void>
	runAll(steps: readonly RecordedMigrationStep<TConnection>[]): Promise<void>
}

/**
 * Creates a ledger-backed sequential executor. The migration work and its
 * post-success ledger row share one transaction. A failed step rolls both back,
 * so the next startup can safely retry it.
 */
export const createRecordedMigrationRunner = async <TConnection>(
	store: MigrationLedgerStore<TConnection>,
): Promise<RecordedMigrationRunner<TConnection>> => {
	const appliedNames = new Set(await store.loadAppliedNames())

	const run = async (step: RecordedMigrationStep<TConnection>): Promise<void> => {
		if (appliedNames.has(step.name)) return

		await store.transaction(async (transaction) => {
			if (await transaction.isMigrationApplied(step.name)) return
			await runMigrationStep({
				name: step.name,
				run: async () => await step.run(transaction.connection),
			})
			await transaction.recordMigration(step.name)
		})

		appliedNames.add(step.name)
	}

	return {
		run,
		async runAll(steps: readonly RecordedMigrationStep<TConnection>[]): Promise<void> {
			for (const step of steps) {
				await run(step)
			}
		},
	}
}

/** Convenience one-shot form for callers that do not need to reuse the loaded set. */
export const runRecordedMigrationStepsSequentially = async <TConnection>(
	store: MigrationLedgerStore<TConnection>,
	steps: readonly RecordedMigrationStep<TConnection>[],
): Promise<void> => {
	const runner = await createRecordedMigrationRunner(store)
	await runner.runAll(steps)
}

export interface ReservedMigrationConnection {
	setLockTimeout(): Promise<void>
	acquireLock(): Promise<void>
	resetLockTimeout(): Promise<void>
	unlock(): Promise<void>
	release(): void
	close(): Promise<void>
}

export type MigrationLockCleanupFailure = 'unlock' | 'connection-close' | 'connection-release'

const reportCleanupFailure = (
	reporter: ((kind: MigrationLockCleanupFailure) => void) | undefined,
	kind: MigrationLockCleanupFailure,
): void => {
	try {
		reporter?.(kind)
	} catch {
		// Observability must not replace the startup error or leak a driver error.
	}
}

/**
 * Holds a session-level migration lock on one reserved connection. A failed
 * unlock quarantines the session instead of returning a possibly locked
 * connection to the pool.
 */
export const withReservedMigrationAdvisoryLock = async <T>(
	connection: ReservedMigrationConnection,
	fn: () => Promise<T>,
	onCleanupFailure?: (kind: MigrationLockCleanupFailure) => void,
): Promise<T> => {
	let lockAcquired = false
	let shouldCloseConnection = false
	let migrationBodyStarted = false
	let workFailed = false
	let workError: unknown
	let result: T | undefined

	try {
		await connection.setLockTimeout()
		await connection.acquireLock()
		lockAcquired = true
		await connection.resetLockTimeout()
		migrationBodyStarted = true
		result = await fn()
	} catch (error) {
		workFailed = true
		workError = error
		// A setup failure can leave a session-level setting or lock in an unknown state.
		if (!migrationBodyStarted) shouldCloseConnection = true
	}

	let cleanupFailed = false
	if (lockAcquired) {
		try {
			await connection.unlock()
		} catch {
			shouldCloseConnection = true
			cleanupFailed = true
			reportCleanupFailure(onCleanupFailure, 'unlock')
		}
	}

	if (shouldCloseConnection) {
		try {
			await connection.close()
		} catch {
			cleanupFailed = true
			reportCleanupFailure(onCleanupFailure, 'connection-close')
		}
	} else {
		try {
			connection.release()
		} catch {
			cleanupFailed = true
			reportCleanupFailure(onCleanupFailure, 'connection-release')
			try {
				await connection.close()
			} catch {
				reportCleanupFailure(onCleanupFailure, 'connection-close')
			}
		}
	}

	if (workFailed) throw workError
	if (cleanupFailed) throw new MigrationLockCleanupError()
	return result as T
}

/** Converts unknown driver errors into startup-safe errors without retaining a cause. */
export const sanitizeMigrationStartupError = (stage: string, error: unknown): Error => {
	if (
		error instanceof MigrationStepError ||
		error instanceof MigrationStartupError ||
		error instanceof MigrationLockCleanupError
	) {
		return error
	}

	return new MigrationStartupError(stage, sqlStateFromError(error))
}
