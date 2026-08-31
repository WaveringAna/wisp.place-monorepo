import { beforeEach, describe, expect, test } from 'bun:test'
import type { PrivateSitesQueryExecutor } from './private-sites-db'

type QueryCall = { text: string; values: unknown[] }
const calls: QueryCall[] = []
let result: unknown[] = []

const sql = Object.assign(
	<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
		calls.push({ text: strings.join('?'), values })
		return Promise.resolve(result as T)
	},
	{ end: async () => undefined },
)
const executor = sql as unknown as PrivateSitesQueryExecutor

const { exchangePrivateShareTokenWithExecutor, loadAuthorizedPrivateSiteWithExecutor } = await import(
	'./private-sites-db'
)

const row = {
	site_id: 'bright-brook-fox-1234',
	owner_did: 'did:plc:owner',
	name: 'secret',
	file_count: 1,
	total_bytes: '4',
	state: 'ready',
	expires_at: null,
	created_at: new Date('2026-01-01T00:00:00Z'),
	updated_at: new Date('2026-01-01T00:00:00Z'),
	file_path: 'index.html',
	file_size: '4',
	file_mime_type: 'text/html',
}

beforeEach(() => {
	calls.length = 0
	result = []
})

describe('private serving primary query plan', () => {
	test('loads a valid cookie session and file metadata in exactly one primary query', async () => {
		result = [row]
		const resolved = await loadAuthorizedPrivateSiteWithExecutor(
			executor,
			'bright-brook-fox-1234',
			'hashed-cookie-only',
		)

		expect(resolved?.site.state).toBe('ready')
		expect(resolved?.files).toEqual([{ path: 'index.html', size: 4, mimeType: 'text/html' }])
		expect(calls).toHaveLength(1)
		const query = calls[0]?.text ?? ''
		expect(query).toContain('private_site_sessions')
		expect(query).toContain('private_site_files')
		expect(query).toContain('session.secret_hash')
		expect(query).toContain("site.state = 'ready'")
		expect(query).toContain('site.expires_at IS NULL OR site.expires_at > NOW()')
		expect(query).toContain('share.revoked_at IS NULL')
		expect(query).toContain('share.expires_at IS NULL OR share.expires_at > NOW()')
		expect(calls[0]?.values).toContain('hashed-cookie-only')
	})

	test('drops malformed MIME metadata before it can become a response header', async () => {
		result = [{ ...row, file_mime_type: 'text/plain\r\nX-Injected: yes' }]
		const resolved = await loadAuthorizedPrivateSiteWithExecutor(
			executor,
			'bright-brook-fox-1234',
			'hashed-cookie-only',
		)

		expect(resolved?.files).toEqual([{ path: 'index.html', size: 4, mimeType: null }])
	})

	test('preserves an empty scoped audience as an audience mismatch', async () => {
		result = [{ kind: 'audienceMismatch', share_id: 'share-1', audience_did: '' }]

		expect(
			await exchangePrivateShareTokenWithExecutor(executor, {
				siteId: 'bright-brook-fox-1234',
				tokenHash: 'hashed-share-token',
				sessionId: 'session-1',
				sessionSecretHash: 'hashed-session-cookie',
				expiresAt: new Date('2026-01-01T01:00:00Z'),
			}),
		).toEqual({ kind: 'audienceMismatch', audienceDid: '' })
	})

	test('validates a share token and creates its session in one atomic query', async () => {
		result = [{ kind: 'share', share_id: 'share-1', audience_did: null }]
		const exchange = await exchangePrivateShareTokenWithExecutor(executor, {
			siteId: 'bright-brook-fox-1234',
			tokenHash: 'hashed-share-token',
			sessionId: 'session-1',
			sessionSecretHash: 'hashed-session-cookie',
			expiresAt: new Date('2026-01-01T01:00:00Z'),
		})

		expect(exchange).toEqual({ kind: 'share', shareId: 'share-1' })
		expect(calls).toHaveLength(1)
		expect(calls[0]?.text).toContain('WITH candidate AS')
		expect(calls[0]?.text).toContain('INSERT INTO private_site_sessions')
		expect(calls[0]?.text).toContain("site.state = 'ready'")
		expect(calls[0]?.text).toContain('share.revoked_at IS NULL')
	})
})
