import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CAS_SCHEMA_STATEMENTS, LABELER_SCHEMA_STATEMENTS } from '@wispplace/database'
import postgres from 'postgres'
import { CacheManager } from './cache-manager'
import { type ClosableDatabasePool, createDatabasePoolCloser, createHostingDb } from './db'

// The lookups read through their own pool on a throwaway schema:
//   WISP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/wisp bun test src/lib/db.test.ts
const url = process.env.WISP_TEST_DATABASE_URL
const schema = `hosting_db_${Math.random().toString(36).slice(2, 10)}`

describe('database pool closer', () => {
	test('ends the pool once across repeated calls', async () => {
		let endCalls = 0
		const pool: ClosableDatabasePool = {
			async end() {
				endCalls++
			},
		}
		const close = createDatabasePoolCloser(pool)

		const firstClose = close()
		const secondClose = close()
		expect(firstClose).toBe(secondClose)
		await Promise.all([firstClose, secondClose])
		await close()

		expect(endCalls).toBe(1)
	})

	test('reports a failed close instead of throwing', async () => {
		let reported = 0
		const pool: ClosableDatabasePool = {
			async end() {
				throw new Error('boom')
			},
		}

		await createDatabasePoolCloser(pool, () => reported++)()
		expect(reported).toBe(1)
	})
})

const suite = url ? describe : describe.skip

suite('getSiteCache (postgres)', () => {
	let admin: postgres.Sql
	let reader: postgres.Sql
	let getSiteCache: ReturnType<typeof createHostingDb>['getSiteCache']
	let listSiteCachePage: ReturnType<typeof createHostingDb>['listSiteCachePage']

	beforeAll(async () => {
		admin = postgres(url as string, { max: 1, onnotice: () => {} })
		reader = postgres(`${url}${url?.includes('?') ? '&' : '?'}search_path=${schema}`, { max: 1 })
		;({ getSiteCache, listSiteCachePage } = createHostingDb({
			sql: reader,
			cache: new CacheManager({ domains: {}, customDomains: {}, settings: {}, siteCache: {} }),
		}))
		await admin.unsafe(`CREATE SCHEMA ${schema}`)
		await admin.unsafe(`SET search_path TO ${schema}`)
		await admin.unsafe(
			"CREATE TABLE site_cache (did TEXT NOT NULL, rkey TEXT NOT NULL, record_cid TEXT NOT NULL, file_cids JSONB NOT NULL DEFAULT '{}', cached_at BIGINT, updated_at BIGINT, absent_since BIGINT, PRIMARY KEY (did, rkey))",
		)
		for (const statement of CAS_SCHEMA_STATEMENTS) await admin.unsafe(statement)
	})

	afterAll(async () => {
		await reader.end()
		await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
		await admin.end()
	})

	test('returns the path to CAS key mapping the files are read from', async () => {
		const objects = { 'index.html': 'cas/bafkreiaaa.deadbeef.html' }
		await admin`
			INSERT INTO site_cache (did, rkey, record_cid, file_cids, file_objects)
			VALUES ('did:plc:test', 'site', 'cid', ${admin.json({ 'index.html': 'bafkreiaaa' })}, ${admin.json(objects)})
		`

		const row = await getSiteCache('did:plc:test', 'site')

		expect(row?.file_objects).toEqual(objects)
	})

	test('pages every site in key order after a cursor', async () => {
		for (const [did, rkey] of [
			['did:plc:b', 'one'],
			['did:plc:a', 'two'],
			['did:plc:a', 'one'],
		]) {
			await admin`INSERT INTO site_cache (did, rkey, record_cid) VALUES (${did}, ${rkey}, 'cid')`
		}

		const first = await listSiteCachePage('', '', 2)
		expect(first.map((row) => `${row.did}/${row.rkey}`)).toEqual(['did:plc:a/one', 'did:plc:a/two'])
		const second = await listSiteCachePage('did:plc:a', 'two', 2)
		expect(second.map((row) => `${row.did}/${row.rkey}`)).toEqual(['did:plc:b/one', 'did:plc:test/site'])
		expect(await listSiteCachePage('did:plc:test', 'site', 2)).toEqual([])
	})
})

suite('loadActiveTakedowns (postgres)', () => {
	const LABELER = 'did:plc:labelerlabelerlabelerlab'
	let admin: postgres.Sql
	let reader: postgres.Sql
	let loadActiveTakedowns: ReturnType<typeof createHostingDb>['loadActiveTakedowns']
	const takedownSchema = `${schema}_labels`

	beforeAll(async () => {
		admin = postgres(url as string, { max: 1, onnotice: () => {} })
		reader = postgres(`${url}${url?.includes('?') ? '&' : '?'}search_path=${takedownSchema}`, { max: 1 })
		;({ loadActiveTakedowns } = createHostingDb({
			sql: reader,
			cache: new CacheManager({ domains: {}, customDomains: {}, settings: {}, siteCache: {} }),
		}))
		await admin.unsafe(`CREATE SCHEMA ${takedownSchema}`)
	})

	afterAll(async () => {
		await reader.end()
		await admin.unsafe(`DROP SCHEMA ${takedownSchema} CASCADE`)
		await admin.end()
	})

	test('is empty before the labeler has created its table', async () => {
		expect(await loadActiveTakedowns(LABELER)).toEqual([])
	})

	test('keeps subjects whose newest !takedown from this labeler is neither negated nor expired', async () => {
		await admin.unsafe(`SET search_path TO ${takedownSchema}`)
		for (const statement of LABELER_SCHEMA_STATEMENTS) await admin.unsafe(statement)
		const insert = (uri: string, opts: { neg?: boolean; exp?: string; val?: string; src?: string } = {}) => admin`
			INSERT INTO labeler_labels (src, uri, val, neg, cts, exp, sig)
			VALUES (${opts.src ?? LABELER}, ${uri}, ${opts.val ?? '!takedown'}, ${opts.neg ?? false},
				'2026-10-16T00:00:00.000Z', ${opts.exp ?? null}, ${new Uint8Array(64)})
		`
		await insert('did:plc:active')
		await insert('at://did:plc:alice/place.wisp.fs/restored')
		await insert('at://did:plc:alice/place.wisp.fs/restored', { neg: true })
		await insert('did:plc:retaken', { neg: true })
		await insert('did:plc:retaken')
		await insert('did:plc:expired', { exp: '2020-01-01T00:00:00.000Z' })
		await insert('did:plc:later', { exp: '2099-01-01T00:00:00.000Z' })
		await insert('did:plc:hidden', { val: '!hide' })
		await insert('did:plc:elsewhere', { src: 'did:plc:someoneelse' })

		expect((await loadActiveTakedowns(LABELER)).sort()).toEqual(['did:plc:active', 'did:plc:later', 'did:plc:retaken'])
	})
})
