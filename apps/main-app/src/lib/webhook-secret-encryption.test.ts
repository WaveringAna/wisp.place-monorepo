import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import {
	decryptWebhookSecret,
	isWebhookSecretEnvelopeCandidate,
	parseWebhookSecretEncryptionKeyring,
} from '@wispplace/atproto-utils'
import type { SQL } from 'bun'
import {
	type LegacyWebhookSecretRow,
	migrateLegacyWebhookSecretRows,
	migrateWebhookSecretEnvelopes,
	type WebhookSecretEnvelopeMigrationStore,
} from './webhook-secret-encryption'

const keyring = parseWebhookSecretEncryptionKeyring({
	WEBHOOK_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 91).toString('base64url'),
})

interface StoredRow extends LegacyWebhookSecretRow {
	token: string
}

class MemorySecretStore implements WebhookSecretEnvelopeMigrationStore {
	rows: StoredRow[]
	beforeCompareAndSwap?: (row: LegacyWebhookSecretRow) => void

	constructor(rows: StoredRow[]) {
		this.rows = rows.map((row) => ({ ...row }))
	}

	async transaction<T>(operation: () => Promise<T>): Promise<T> {
		const snapshot = this.rows.map((row) => ({ ...row }))
		try {
			return await operation()
		} catch (error) {
			this.rows = snapshot
			throw error
		}
	}

	async selectLegacyBatch(limit: number): Promise<ReadonlyArray<LegacyWebhookSecretRow>> {
		return this.rows
			.filter((row) => !isWebhookSecretEnvelopeCandidate(row.token))
			.slice(0, limit)
			.map((row) => ({ ...row }))
	}

	async compareAndSwap(row: LegacyWebhookSecretRow, envelope: string): Promise<boolean> {
		this.beforeCompareAndSwap?.(row)
		const stored = this.rows.find((candidate) => candidate.did === row.did && candidate.name === row.name)
		if (!stored || stored.token !== row.token) return false
		stored.token = envelope
		return true
	}

	async countLegacy(): Promise<number> {
		return this.rows.filter((row) => !isWebhookSecretEnvelopeCandidate(row.token)).length
	}
}

const legacyRows = (): StoredRow[] => [
	{ did: 'did:plc:alice', name: 'first', token: 'wsk_plaintext-first' },
	{ did: 'did:plc:alice', name: 'second', token: 'wsk_plaintext-second' },
]

describe('webhook secret envelope migration', () => {
	test('does not silently preserve legacy plaintext when no key is available', async () => {
		const store = new MemorySecretStore(legacyRows())
		const result = await migrateLegacyWebhookSecretRows(store, null)

		expect(result).toEqual({ encrypted: 0, legacyRemaining: 2, encryptionAvailable: false })
		expect(store.rows.map((row) => row.token)).toEqual(['wsk_plaintext-first', 'wsk_plaintext-second'])
	})

	test('stores only envelopes after a successful migration, never the raw database token', async () => {
		const store = new MemorySecretStore(legacyRows())
		const rawTokens = store.rows.map((row) => row.token)
		const result = await migrateLegacyWebhookSecretRows(store, keyring, { batchSize: 1 })

		expect(result).toEqual({ encrypted: 2, legacyRemaining: 0, encryptionAvailable: true })
		for (const [index, row] of store.rows.entries()) {
			expect(isWebhookSecretEnvelopeCandidate(row.token)).toBe(true)
			expect(row.token).not.toContain(rawTokens[index]!)
			expect(decryptWebhookSecret(row.token, keyring)).toBe(rawTokens[index])
		}
	})

	test('resumes after a crash following a committed batch', async () => {
		const store = new MemorySecretStore(legacyRows())
		let crashOnce = true
		await expect(
			migrateLegacyWebhookSecretRows(store, keyring, {
				batchSize: 1,
				afterBatchCommitted: () => {
					if (crashOnce) {
						crashOnce = false
						throw new Error('simulated process stop')
					}
				},
			}),
		).rejects.toThrow('simulated process stop')

		// The first transaction was committed before the process stopped.
		expect(isWebhookSecretEnvelopeCandidate(store.rows[0]!.token)).toBe(true)
		expect(store.rows[1]!.token).toBe('wsk_plaintext-second')

		const resumed = await migrateLegacyWebhookSecretRows(store, keyring, { batchSize: 1 })
		expect(resumed).toEqual({ encrypted: 1, legacyRemaining: 0, encryptionAvailable: true })
		expect(store.rows.map((row) => decryptWebhookSecret(row.token, keyring))).toEqual([
			'wsk_plaintext-first',
			'wsk_plaintext-second',
		])
	})

	test('leaves a changed row for the next idempotent compare-and-swap pass', async () => {
		const store = new MemorySecretStore([{ did: 'did:plc:alice', name: 'first', token: 'wsk_original' }])
		store.beforeCompareAndSwap = () => {
			store.beforeCompareAndSwap = undefined
			store.rows[0]!.token = 'wsk_changed-by-old-instance'
		}

		const first = await migrateLegacyWebhookSecretRows(store, keyring)
		expect(first).toEqual({ encrypted: 0, legacyRemaining: 1, encryptionAvailable: true })
		expect(store.rows[0]!.token).toBe('wsk_changed-by-old-instance')

		const resumed = await migrateLegacyWebhookSecretRows(store, keyring)
		expect(resumed).toEqual({ encrypted: 1, legacyRemaining: 0, encryptionAvailable: true })
		expect(decryptWebhookSecret(store.rows[0]!.token, keyring)).toBe('wsk_changed-by-old-instance')
	})

	test('uses a reserved transaction and a separate advisory lock around production storage migration', async () => {
		const store = new MemorySecretStore([{ did: 'did:plc:alice', name: 'first', token: 'wsk_raw-db-token' }])
		const statements: string[] = []
		let released = false
		let closed = false
		let reserved: unknown

		const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const statement = strings.join('?').replace(/\s+/g, ' ').trim()
			statements.push(statement)
			if (statement.includes('SELECT did, name, token')) return await store.selectLegacyBatch(values[1] as number)
			if (statement.includes('UPDATE webhook_secrets')) {
				return (await store.compareAndSwap(
					{ did: values[1] as string, name: values[2] as string, token: values[3] as string },
					values[0] as string,
				))
					? [{ did: values[1] as string }]
					: []
			}
			if (statement.includes('SELECT COUNT(*)')) return [{ count: await store.countLegacy() }]
			if (statement.includes('pg_advisory_unlock')) return [{ unlocked: true }]
			return []
		}

		reserved = Object.assign(tag, {
			begin: async <T>(operation: () => Promise<T>): Promise<T> => await store.transaction(operation),
			release: () => {
				released = true
			},
			close: async () => {
				closed = true
			},
		})
		const database = { reserve: async () => reserved } as unknown as SQL

		const result = await migrateWebhookSecretEnvelopes(database, keyring)
		expect(result).toEqual({ encrypted: 1, legacyRemaining: 0, encryptionAvailable: true })
		expect(store.rows[0]!.token).not.toContain('wsk_raw-db-token')
		expect(decryptWebhookSecret(store.rows[0]!.token, keyring)).toBe('wsk_raw-db-token')
		expect(statements.some((statement) => statement === 'BEGIN')).toBe(true)
		expect(statements.some((statement) => statement === 'COMMIT')).toBe(true)
		expect(statements.some((statement) => statement.includes('pg_advisory_lock'))).toBe(true)
		expect(statements.some((statement) => statement.includes('pg_advisory_unlock'))).toBe(true)
		expect(released).toBe(true)
		expect(closed).toBe(false)
	})
})
