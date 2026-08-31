import { beforeEach, describe, expect, mock, test } from 'bun:test'

type QueryCall = { source: 'primary' | 'transaction'; text: string; values: unknown[] }

const calls: QueryCall[] = []
const transactionEvents: string[] = []
let failBulkFileInsert = false
let selectResult: unknown[] = []

const stagedRow = {
	site_id: 'bright-brook-fox-1234',
	owner_did: 'did:plc:owner',
	name: 'private',
	file_count: 2,
	total_bytes: 3,
	state: 'staging',
	expires_at: null,
	created_at: new Date('2026-01-01T00:00:00Z'),
	updated_at: new Date('2026-01-01T00:00:00Z'),
}

const execute = async (source: QueryCall['source'], strings: TemplateStringsArray, values: unknown[]) => {
	const text = strings.join('?')
	calls.push({ source, text, values })
	if (text.includes('INSERT INTO private_sites')) return [stagedRow]
	if (text.includes('INSERT INTO private_site_files')) {
		if (failBulkFileInsert) throw new Error('bulk file rows rejected')
		return []
	}
	return selectResult
}

type ArrayParameter = { values: unknown[]; type: string | number | undefined }

const transactionSql = Object.assign(
	<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> =>
		execute('transaction', strings, values) as Promise<T>,
	{
		array: (values: unknown[], type?: string | number): ArrayParameter => ({ values, type }),
	},
)
const primarySql = Object.assign(
	<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> =>
		execute('primary', strings, values) as Promise<T>,
	{
		begin: async <T>(callback: (transaction: typeof transactionSql) => Promise<T>): Promise<T> => {
			transactionEvents.push('begin')
			try {
				const result = await callback(transactionSql)
				transactionEvents.push('commit')
				return result
			} catch (error) {
				transactionEvents.push('rollback')
				throw error
			}
		},
	},
)

mock.module('./db', () => ({ db: primarySql }))

const {
	claimPrivateSiteDeletionForOwner,
	claimPrivateSitesForReaping,
	createPrivateSite,
	finalizePrivateSiteDeletion,
	hasLivePrivateSite,
	markPrivateSiteReady,
	renewPrivateSiteStagingLease,
} = await import('./private-sites-db')

// Keep this test's module replacement from leaking into unrelated test files.
mock.restore()

const input = {
	ownerDid: 'did:plc:owner',
	name: 'private',
	expiresAt: null,
	files: [
		{ path: 'index.html', size: 1, mimeType: 'text/html', sha256: 'a'.repeat(64) },
		{ path: 'app.js', size: 2, mimeType: 'text/javascript', sha256: 'b'.repeat(64) },
	],
}

beforeEach(() => {
	calls.length = 0
	transactionEvents.length = 0
	failBulkFileInsert = false
	selectResult = []
})

describe('private site metadata lifecycle repository', () => {
	test('inserts parent and all file rows in two transaction statements', async () => {
		const staged = await createPrivateSite(input)

		expect(staged.site.state).toBe('staging')
		expect(staged.leaseToken).toHaveLength(43)
		expect(transactionEvents).toEqual(['begin', 'commit'])
		expect(calls.map((call) => call.source)).toEqual(['transaction', 'transaction'])
		expect(calls[0]?.text).toContain('staging_lease_token_hash, staging_lease_expires_at, expires_at')
		expect(calls[0]?.text).toContain("'staging'")
		expect(calls[1]?.text).toContain('FROM UNNEST')
		expect(calls[1]?.text).toContain('::TEXT[]')
		expect(calls[1]?.text).toContain('::BIGINT[]')
		expect(calls[1]?.text).toContain('::BOOLEAN[]')
		expect(calls[1]?.text).toContain('CASE WHEN file_row.mime_is_null')
		expect(calls.filter((call) => call.text.includes('INSERT INTO private_site_files'))).toHaveLength(1)
	})

	test('rolls back parent metadata when the bulk file statement fails', async () => {
		failBulkFileInsert = true

		await expect(createPrivateSite(input)).rejects.toThrow('bulk file rows rejected')
		expect(transactionEvents).toEqual(['begin', 'rollback'])
		expect(calls.map((call) => call.source)).toEqual(['transaction', 'transaction'])
	})

	test('rejects unsafe MIME metadata before it reaches the database', async () => {
		await expect(
			createPrivateSite({
				...input,
				files: [{ ...input.files[0]!, mimeType: 'text/plain\r\nX-Injected: yes' }],
			}),
		).rejects.toThrow('invalid private site file metadata')
		expect(calls).toHaveLength(0)
	})

	test('keeps a 500-file manifest at two transaction statements', async () => {
		const files = Array.from({ length: 500 }, (_, index) => ({
			path: `assets/${index}.txt`,
			size: 1,
			mimeType: index % 2 === 0 ? null : 'text/plain',
			sha256: index.toString(16).padStart(64, '0'),
		}))

		await createPrivateSite({ ...input, files })

		expect(transactionEvents).toEqual(['begin', 'commit'])
		expect(calls).toHaveLength(2)
		const arrayParameters = calls[1]?.values.slice(1) as ArrayParameter[]
		expect(arrayParameters).toHaveLength(5)
		expect(arrayParameters.map((parameter) => parameter.values.length)).toEqual([500, 500, 500, 500, 500])
		expect(arrayParameters.map((parameter) => parameter.type)).toEqual(['TEXT', 'BIGINT', 'TEXT', 'BOOL', 'TEXT'])
	})

	test('renews only the matching unexpired staging lease before a write', async () => {
		selectResult = [{ site_id: 'bright-brook-fox-1234' }]
		expect(await renewPrivateSiteStagingLease('bright-brook-fox-1234', 'lease-token')).toBe(true)

		const query = calls[0]?.text ?? ''
		expect(query).toContain('staging_lease_expires_at = NOW()')
		expect(query).toContain("state = 'staging'")
		expect(query).toContain('staging_lease_token_hash')
		expect(query).toContain('staging_lease_expires_at > NOW()')
		expect(calls[0]?.values).not.toContain('lease-token')
	})

	test('publishes only staging rows and keeps expiry in the transition predicate', async () => {
		selectResult = [{ ...stagedRow, state: 'ready' }]
		const ready = await markPrivateSiteReady('bright-brook-fox-1234', 'lease-token')

		expect(ready?.state).toBe('ready')
		expect(calls).toHaveLength(1)
		expect(calls[0]?.source).toBe('primary')
		expect(calls[0]?.text).toContain("state = 'staging'")
		expect(calls[0]?.text).toContain('expires_at IS NULL OR expires_at > NOW()')
	})

	test('uses a direct primary, metadata-free live predicate for TLS', async () => {
		selectResult = []
		expect(await hasLivePrivateSite('bright-brook-fox-1234')).toBe(false)

		const query = calls[0]
		expect(query?.source).toBe('primary')
		expect(query?.text).toContain('SELECT 1')
		expect(query?.text).toContain("state = 'ready'")
		expect(query?.text).toContain('expires_at IS NULL OR expires_at > NOW()')
		expect(query?.text).not.toContain('owner_did')
		expect(query?.text).not.toContain('total_bytes')
	})

	test('commits an owner deletion barrier before any storage worker can run', async () => {
		selectResult = [{ ...stagedRow, state: 'deleting' }]
		const claim = await claimPrivateSiteDeletionForOwner('bright-brook-fox-1234', 'did:plc:owner')

		expect(claim).toMatchObject({ claimed: true, site: { state: 'deleting' } })
		expect(calls).toHaveLength(1)
		expect(calls[0]?.text).toContain("state = 'deleting'")
		expect(calls[0]?.text).toContain("state = 'ready'")
		expect(calls[0]?.text).not.toContain('private_site_files')
	})

	test('only finalizes a row that was already hidden as deleting', async () => {
		selectResult = []
		expect(await finalizePrivateSiteDeletion('bright-brook-fox-1234')).toBe(false)
		expect(calls[0]?.text).toContain('DELETE FROM private_sites')
		expect(calls[0]?.text).toContain("state = 'deleting'")
	})

	test('claims expired and stale hidden work with SKIP LOCKED before storage cleanup', async () => {
		selectResult = [{ ...stagedRow, state: 'deleting' }]
		const claimed = await claimPrivateSitesForReaping(100, 60_000)

		expect(claimed[0]?.state).toBe('deleting')
		const query = calls[0]?.text ?? ''
		expect(query).toContain('FOR UPDATE SKIP LOCKED')
		expect(query).toContain("state = 'staging'")
		expect(query).toContain('staging_lease_expires_at <= NOW()')
		expect(query).toContain("state = 'deleting'")
		expect(query).toContain('staging_lease_token_hash = NULL')
	})
})
