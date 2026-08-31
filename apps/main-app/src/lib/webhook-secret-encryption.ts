import {
	encryptWebhookSecret,
	WEBHOOK_SECRET_ENVELOPE_PREFIX,
	type WebhookSecretEncryptionKeyring,
} from '@wispplace/atproto-utils'
import type { SQL } from 'bun'

const WEBHOOK_SECRET_MIGRATION_LOCK_KEY = 0x5749535057454e43n // "WISPWENC"
const DEFAULT_BATCH_SIZE = 100
const DEFAULT_MAX_BATCHES = 1000

export const WEBHOOK_SECRET_ENCRYPTION_MIGRATION_ERROR = 'webhook_secret_encryption_migration_unavailable'

/** Deliberately generic: database values and driver details must never reach logs or API errors. */
export class WebhookSecretEncryptionMigrationError extends Error {
	constructor() {
		super(WEBHOOK_SECRET_ENCRYPTION_MIGRATION_ERROR)
		this.name = 'WebhookSecretEncryptionMigrationError'
	}
}

export interface LegacyWebhookSecretRow {
	readonly did: string
	readonly name: string
	readonly token: string
}

export interface WebhookSecretEnvelopeMigrationResult {
	readonly encrypted: number
	readonly legacyRemaining: number
	readonly encryptionAvailable: boolean
}

export interface WebhookSecretEnvelopeMigrationOptions {
	/** Bounded so one migration transaction cannot lock an unbounded table. */
	readonly batchSize?: number
	/** Bounded work per startup; a later startup safely resumes remaining rows. */
	readonly maxBatches?: number
	/** Test/operational hook. It receives counts only, never a secret. */
	readonly afterBatchCommitted?: (progress: { encrypted: number; batches: number }) => Promise<void> | void
}

/**
 * Transactional storage abstraction used to make crash/resume behavior testable.
 * The production adapter below binds every call to one advisory-lock-owning
 * reserved PostgreSQL connection.
 */
export interface WebhookSecretEnvelopeMigrationStore {
	transaction<T>(operation: () => Promise<T>): Promise<T>
	selectLegacyBatch(limit: number): Promise<ReadonlyArray<LegacyWebhookSecretRow>>
	compareAndSwap(row: LegacyWebhookSecretRow, envelope: string): Promise<boolean>
	countLegacy(): Promise<number>
}

function migrationFailure(): never {
	throw new WebhookSecretEncryptionMigrationError()
}

const boundedPositiveInteger = (value: number | undefined, fallback: number, maximum: number): number => {
	const result = value ?? fallback
	if (!Number.isSafeInteger(result) || result < 1 || result > maximum) migrationFailure()
	return result
}

/**
 * Convert legacy plaintext rows using a transactional store. Each committed
 * batch has a compare-and-swap update, so a crash after a commit is safe to
 * resume: committed rows are skipped and uncommitted rows stay plaintext.
 */
export const migrateLegacyWebhookSecretRows = async (
	store: WebhookSecretEnvelopeMigrationStore,
	keyring: WebhookSecretEncryptionKeyring | null,
	options: WebhookSecretEnvelopeMigrationOptions = {},
): Promise<WebhookSecretEnvelopeMigrationResult> => {
	const batchSize = boundedPositiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE)
	const maxBatches = boundedPositiveInteger(options.maxBatches, DEFAULT_MAX_BATCHES, DEFAULT_MAX_BATCHES)

	if (!keyring) {
		const legacyRemaining = await store.transaction(async () => await store.countLegacy())
		if (!Number.isSafeInteger(legacyRemaining) || legacyRemaining < 0) migrationFailure()
		return { encrypted: 0, legacyRemaining, encryptionAvailable: false }
	}

	let encrypted = 0
	for (let batches = 0; batches < maxBatches; batches++) {
		const batch = await store.transaction(async () => {
			const rows = await store.selectLegacyBatch(batchSize)
			if (rows.length > batchSize) migrationFailure()

			let updated = 0
			for (const row of rows) {
				if (typeof row.did !== 'string' || typeof row.name !== 'string' || typeof row.token !== 'string') {
					migrationFailure()
				}
				const envelope = encryptWebhookSecret(row.token, keyring)
				if (await store.compareAndSwap(row, envelope)) updated++
			}
			return { selected: rows.length, updated }
		})

		encrypted += batch.updated
		if (batch.selected === 0 || batch.updated === 0) break
		await options.afterBatchCommitted?.({ encrypted, batches: batches + 1 })
	}

	const legacyRemaining = await store.transaction(async () => await store.countLegacy())
	if (!Number.isSafeInteger(legacyRemaining) || legacyRemaining < 0) migrationFailure()
	return { encrypted, legacyRemaining, encryptionAvailable: true }
}

const countFromRow = (value: unknown): number => {
	const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
	if (!Number.isSafeInteger(numberValue) || numberValue < 0) migrationFailure()
	return numberValue
}

/**
 * Encrypt all legacy plaintext webhook tokens under a distinct, session-scoped
 * PostgreSQL advisory lock. This runs only after the normal schema migration
 * created `webhook_secrets`; it intentionally does not share or race that
 * migration lock.
 */
export const migrateWebhookSecretEnvelopes = async (
	database: SQL,
	keyring: WebhookSecretEncryptionKeyring | null,
	options: WebhookSecretEnvelopeMigrationOptions = {},
): Promise<WebhookSecretEnvelopeMigrationResult> => {
	let reserved: Awaited<ReturnType<SQL['reserve']>> | undefined
	let lockHeld = false
	let connectionMustClose = false
	let failed = false
	let result: WebhookSecretEnvelopeMigrationResult | undefined

	try {
		reserved = await database.reserve()
		await reserved`SET lock_timeout = '30s'`
		await reserved`SELECT pg_advisory_lock(${WEBHOOK_SECRET_MIGRATION_LOCK_KEY}::bigint)`
		lockHeld = true

		const legacyPrefix = `${WEBHOOK_SECRET_ENVELOPE_PREFIX}%`
		const store: WebhookSecretEnvelopeMigrationStore = {
			transaction: async <T>(operation: () => Promise<T>): Promise<T> => {
				// Use the advisory-lock-owning reserved connection itself. Calling
				// SQL.begin() on a generic client could reserve a different session.
				await reserved!`BEGIN`
				try {
					const value = await operation()
					await reserved!`COMMIT`
					return value
				} catch (error) {
					try {
						await reserved!`ROLLBACK`
					} catch {
						// The caller receives the same generic migration failure below.
					}
					throw error
				}
			},
			selectLegacyBatch: async (limit) => {
				const rows = await reserved!<Array<LegacyWebhookSecretRow>>`
					SELECT did, name, token
					FROM webhook_secrets
					WHERE token NOT LIKE ${legacyPrefix}
					ORDER BY did ASC, name ASC
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				`
				return rows
			},
			compareAndSwap: async (row, envelope) => {
				const rows = await reserved!<Array<{ did: string }>>`
					UPDATE webhook_secrets
					SET token = ${envelope}
					WHERE did = ${row.did}
						AND name = ${row.name}
						AND token = ${row.token}
					RETURNING did
				`
				return rows.length === 1
			},
			countLegacy: async () => {
				const rows = await reserved!<Array<{ count: number | string }>>`
					SELECT COUNT(*) AS count
					FROM webhook_secrets
					WHERE token NOT LIKE ${legacyPrefix}
				`
				return countFromRow(rows[0]?.count)
			},
		}

		result = await migrateLegacyWebhookSecretRows(store, keyring, options)
	} catch {
		failed = true
	} finally {
		if (reserved) {
			if (lockHeld) {
				try {
					const rows = await reserved<Array<{ unlocked: boolean }>>`
						SELECT pg_advisory_unlock(${WEBHOOK_SECRET_MIGRATION_LOCK_KEY}::bigint) AS unlocked
					`
					if (!rows[0]?.unlocked) {
						failed = true
						connectionMustClose = true
					}
				} catch {
					failed = true
					connectionMustClose = true
				}
			}

			if (!connectionMustClose) {
				try {
					await reserved`SET lock_timeout = DEFAULT`
				} catch {
					failed = true
					connectionMustClose = true
				}
			}

			if (connectionMustClose) {
				try {
					await reserved.close({ timeout: 0 })
				} catch {
					failed = true
				}
			} else {
				try {
					reserved.release()
				} catch {
					failed = true
				}
			}
		}
	}

	if (failed || !result) return migrationFailure()
	return result
}
