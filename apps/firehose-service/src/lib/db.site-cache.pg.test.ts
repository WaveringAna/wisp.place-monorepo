import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CAS_SCHEMA_STATEMENTS } from '@wispplace/database'
import postgres from 'postgres'

// The module binds its connection at import, so point it at a throwaway schema first:
//   WISP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/wisp bun test src/lib/db.site-cache.pg.test.ts
const url = process.env.WISP_TEST_DATABASE_URL
const schema = `fh_site_cache_${Math.random().toString(36).slice(2, 10)}`
if (url) process.env.DATABASE_URL = `${url}${url.includes('?') ? '&' : '?'}search_path=${schema}`
const { getSiteCache } = await import('./db')

const suite = url ? describe : describe.skip

suite('getSiteCache (postgres)', () => {
	let admin: postgres.Sql

	beforeAll(async () => {
		admin = postgres(url as string, { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${schema}`)
		await admin.unsafe(`SET search_path TO ${schema}`)
		await admin.unsafe(
			"CREATE TABLE site_cache (did TEXT NOT NULL, rkey TEXT NOT NULL, record_cid TEXT NOT NULL, file_cids JSONB NOT NULL DEFAULT '{}', cached_at BIGINT, updated_at BIGINT, cold_synced BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY (did, rkey))",
		)
		for (const statement of CAS_SCHEMA_STATEMENTS) await admin.unsafe(statement)
	})

	afterAll(async () => {
		await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
		await admin.end()
	})

	test('returns the path to CAS key mapping the update ledger is built from', async () => {
		const objects = { 'index.html': 'cas/bafkreiaaa.deadbeef.html' }
		await admin`
			INSERT INTO site_cache (did, rkey, record_cid, file_cids, file_objects)
			VALUES ('did:plc:test', 'site', 'cid', ${admin.json({ 'index.html': 'bafkreiaaa' })}, ${admin.json(objects)})
		`

		const row = await getSiteCache('did:plc:test', 'site')

		expect(row?.file_objects).toEqual(objects)
	})
})
