import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DELETED_SITE_RECORD_CID } from '@wispplace/constants'
import { CAS_SCHEMA_STATEMENTS } from '@wispplace/database'
import postgres from 'postgres'

// The module binds its connection at import, so point it at a throwaway schema first:
//   WISP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/wisp bun test --isolate src/lib/db.repo-absence.pg.test.ts
const url = process.env.WISP_TEST_DATABASE_URL
const schema = `fh_repo_absence_${Math.random().toString(36).slice(2, 10)}`
if (url) process.env.DATABASE_URL = `${url}${url.includes('?') ? '&' : '?'}search_path=${schema}`
const { clearSiteAbsent, insertMissingSiteTombstone, markSiteAbsent, upsertSiteCache } = await import('./db')

const suite = url ? describe : describe.skip

/** The writes the repo-absence check makes when it confirms a site, in its order. */
async function confirm(did: string, rkey: string) {
	if ((await markSiteAbsent(did, rkey)) === null) await insertMissingSiteTombstone(did, rkey)
}

suite('repo-absence site_cache writes (postgres)', () => {
	let admin: postgres.Sql
	const site = async (did: string) =>
		(
			await admin<Array<{ record_cid: string; file_cids: unknown; absent_since: string | null }>>`
				SELECT record_cid, file_cids, absent_since FROM site_cache WHERE did = ${did} AND rkey = 'site'
			`
		)[0]
	const domains = async () => ({
		domains: await admin`SELECT domain, did, rkey FROM domains ORDER BY domain`,
		custom: await admin`SELECT id, domain, did, rkey, verified FROM custom_domains ORDER BY id`,
	})

	beforeAll(async () => {
		admin = postgres(url as string, { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${schema}`)
		await admin.unsafe(`SET search_path TO ${schema}`)
		await admin.unsafe(
			"CREATE TABLE site_cache (did TEXT NOT NULL, rkey TEXT NOT NULL, record_cid TEXT NOT NULL, file_cids JSONB NOT NULL DEFAULT '{}', cached_at BIGINT, updated_at BIGINT, cold_synced BOOLEAN NOT NULL DEFAULT true, absent_since BIGINT, absent_checks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (did, rkey))",
		)
		await admin.unsafe(
			'CREATE TABLE domains (domain TEXT PRIMARY KEY, did TEXT NOT NULL, rkey TEXT, created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()))',
		)
		await admin.unsafe(
			'CREATE TABLE custom_domains (id TEXT PRIMARY KEY, domain TEXT UNIQUE NOT NULL, did TEXT NOT NULL, rkey TEXT, verified BOOLEAN DEFAULT false, last_verified_at BIGINT, created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()))',
		)
		for (const statement of CAS_SCHEMA_STATEMENTS) await admin.unsafe(statement)
		await admin`
			INSERT INTO domains (domain, did, rkey) VALUES
				('gone.wisp.place', 'did:plc:gone', 'site'),
				('norow.wisp.place', 'did:plc:norow', 'site')
		`
		await admin`
			INSERT INTO custom_domains (id, domain, did, rkey, verified) VALUES
				('c1', 'gone.example.com', 'did:plc:gone', 'site', true),
				('c2', 'norow.example.com', 'did:plc:norow', 'site', true)
		`
		await admin`
			INSERT INTO site_cache (did, rkey, record_cid, file_cids)
			VALUES ('did:plc:gone', 'site', 'bafyrecord', ${admin.json({ 'index.html': 'bafkreiaaa' })})
		`
	})

	afterAll(async () => {
		await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
		await admin.end()
	})

	test('confirming marks a cached site absent and keeps its manifest and domain claims', async () => {
		const before = await domains()
		await confirm('did:plc:gone', 'site')
		const row = await site('did:plc:gone')
		expect(row?.record_cid).toBe('bafyrecord')
		expect(row?.absent_since).not.toBeNull()
		expect(row?.file_cids).toEqual({ 'index.html': 'bafkreiaaa' })
		expect(await domains()).toEqual(before)
	})

	test('confirming a site with no cache row tombstones it without touching domain claims', async () => {
		const before = await domains()
		await confirm('did:plc:norow', 'site')
		const row = await site('did:plc:norow')
		expect(row?.record_cid).toBe(DELETED_SITE_RECORD_CID)
		expect(row?.file_cids).toEqual({})
		// A second confirmation leaves the tombstone as is.
		expect(await insertMissingSiteTombstone('did:plc:norow', 'site')).toBe(false)
		expect(await domains()).toEqual(before)
	})

	test('never overwrites an existing row', async () => {
		expect(await insertMissingSiteTombstone('did:plc:gone', 'site')).toBe(false)
		expect((await site('did:plc:gone'))?.record_cid).toBe('bafyrecord')
	})

	test('a returning repo is served again: the mark clears and a materialization replaces the tombstone', async () => {
		const before = await domains()
		expect(await clearSiteAbsent('did:plc:gone', 'site')).toBe(true)
		const restored = await site('did:plc:gone')
		expect(restored?.absent_since ?? null).toBeNull()
		expect(restored?.file_cids).toEqual({ 'index.html': 'bafkreiaaa' })

		await upsertSiteCache('did:plc:norow', 'site', 'bafynew', { 'index.html': 'bafkreibbb' })
		const materialized = await site('did:plc:norow')
		expect(materialized?.record_cid).toBe('bafynew')
		expect(materialized?.absent_since ?? null).toBeNull()
		expect(await domains()).toEqual(before)
	})
})
