import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CAS_SCHEMA_STATEMENTS } from '@wispplace/database'
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

	beforeAll(async () => {
		admin = postgres(url as string, { max: 1, onnotice: () => {} })
		reader = postgres(`${url}${url?.includes('?') ? '&' : '?'}search_path=${schema}`, { max: 1 })
		;({ getSiteCache } = createHostingDb({
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
})
