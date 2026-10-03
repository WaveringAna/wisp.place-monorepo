import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { CAS_SCHEMA_STATEMENTS } from '@wispplace/database'
import { casKey, type FileObjects } from '@wispplace/fs-utils'
import postgres from 'postgres'
import {
	applyCasReferences,
	commitMigratedMapping,
	listSitesForMigration,
	recordCasObject,
	touchCasObjects,
} from './cas-objects'

// Needs a real Postgres: the guarantees under test are row locks, atomicity and concurrency.
// Runs against a throw-away schema, never the real tables. Example:
//   WISP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/wisp bun test src/lib/cas-objects.pg.test.ts
const url = process.env.WISP_TEST_DATABASE_URL
const suite = url ? describe : describe.skip

const schema = `cas_test_${Math.random().toString(36).slice(2, 10)}`
const cid = (letter: string) => `bafkrei${letter.repeat(52)}`
const key = (letter: string, path = 'x.css') => casKey({ cid: cid(letter), path, mimeType: 'text/css' })
const DID = 'did:plc:test'

suite('applyCasReferences (postgres)', () => {
	let sql: postgres.Sql

	const refs = async (k: string) =>
		(
			await sql<Array<{ refs: number; unreferenced_at: string | null }>>`
			SELECT refs, unreferenced_at FROM cas_objects WHERE key = ${k}
		`
		)[0]

	const stored = async (rkey: string) =>
		(
			await sql<Array<{ file_objects: unknown }>>`
			SELECT file_objects FROM site_cache WHERE did = ${DID} AND rkey = ${rkey}
		`
		)[0]?.file_objects

	/** One site write: the row and its references move together, as upsertSiteCache will do. */
	const writeSite = (rkey: string, next: FileObjects | null) =>
		sql.begin(async (tx) => {
			await tx`
				INSERT INTO site_cache (did, rkey, record_cid) VALUES (${DID}, ${rkey}, 'cid')
				ON CONFLICT (did, rkey) DO NOTHING
			`
			return await applyCasReferences(tx as unknown as postgres.Sql, DID, rkey, next)
		})

	beforeAll(async () => {
		sql = postgres(url as string, { max: 20, onnotice: () => {}, connection: { search_path: schema } })
		await sql.unsafe(`CREATE SCHEMA ${schema}`)
		await sql.unsafe(`
			CREATE TABLE site_cache (
				did TEXT NOT NULL, rkey TEXT NOT NULL, record_cid TEXT NOT NULL,
				file_cids JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (did, rkey)
			)
		`)
		for (const statement of CAS_SCHEMA_STATEMENTS) await sql.unsafe(statement)
	})

	afterAll(async () => {
		await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)
		await sql.end()
	})

	beforeEach(async () => {
		await sql`TRUNCATE site_cache, cas_objects`
	})

	test('a first CAS write takes one reference per key and stores the mapping', async () => {
		const objects = { 'a.css': key('a'), 'b/a.css': key('a'), 'c.css': key('b') }
		await writeSite('one', objects)

		expect((await refs(key('a')))?.refs).toBe(1)
		expect((await refs(key('b')))?.refs).toBe(1)
		expect(await stored('one')).toEqual(objects)
	})

	test('two sites sharing a key hold two references; the key is unreferenced only after both let go', async () => {
		await writeSite('one', { 'a.css': key('a') })
		await writeSite('two', { 'z.css': key('a') })
		expect((await refs(key('a')))?.refs).toBe(2)

		await writeSite('one', {})
		const afterOne = await refs(key('a'))
		expect(afterOne?.refs).toBe(1)
		expect(afterOne?.unreferenced_at).toBeNull()

		await writeSite('two', {})
		const afterTwo = await refs(key('a'))
		expect(afterTwo?.refs).toBe(0)
		expect(afterTwo?.unreferenced_at).not.toBeNull()
	})

	test('referencing a freshly written object stops its garbage-collection clock', async () => {
		await recordCasObject(sql, key('a'), 10)
		expect((await refs(key('a')))?.unreferenced_at).not.toBeNull()

		await writeSite('one', { 'a.css': key('a') })

		const row = await refs(key('a'))
		expect(row?.refs).toBe(1)
		expect(row?.unreferenced_at).toBeNull()
	})

	test('an update only moves the references that changed', async () => {
		await writeSite('one', { 'a.css': key('a'), 'b.css': key('b') })
		const diff = await writeSite('one', { 'renamed.css': key('a'), 'c.css': key('c') })

		expect([...diff.added]).toEqual([key('c')])
		expect([...diff.removed]).toEqual([key('b')])
		expect((await refs(key('a')))?.refs).toBe(1)
		expect((await refs(key('b')))?.refs).toBe(0)
		expect((await refs(key('c')))?.refs).toBe(1)
	})

	test('rewriting the same mapping changes nothing', async () => {
		const objects = { 'a.css': key('a') }
		await writeSite('one', objects)
		const diff = await writeSite('one', { ...objects })

		expect(diff.added.size + diff.removed.size).toBe(0)
		expect((await refs(key('a')))?.refs).toBe(1)
	})

	test('going back to legacy (null) or deleting a site releases everything and clears the column', async () => {
		await writeSite('one', { 'a.css': key('a'), 'b.css': key('b') })
		await writeSite('one', null)

		expect((await refs(key('a')))?.refs).toBe(0)
		expect((await refs(key('b')))?.refs).toBe(0)
		expect(await stored('one')).toBeNull()
	})

	test('a legacy site staying legacy touches no CAS state', async () => {
		const diff = await writeSite('legacy', null)

		expect(diff.added.size + diff.removed.size).toBe(0)
		expect(await stored('legacy')).toBeNull()
		expect((await sql`SELECT 1 FROM cas_objects`).length).toBe(0)
	})

	test('releasing a key that has no row neither creates one nor goes negative', async () => {
		await sql`
			INSERT INTO site_cache (did, rkey, record_cid, file_objects)
			VALUES (${DID}, 'ghost', 'cid', ${sql.json({ 'a.css': key('a') })})
		`
		await sql.begin(async (tx) => {
			await applyCasReferences(tx as unknown as postgres.Sql, DID, 'ghost', null)
		})

		expect(await refs(key('a'))).toBeUndefined()
	})

	test('a transaction that aborts leaves references and the mapping untouched', async () => {
		await writeSite('one', { 'a.css': key('a') })

		await expect(
			sql.begin(async (tx) => {
				await applyCasReferences(tx as unknown as postgres.Sql, DID, 'one', { 'b.css': key('b') })
				throw new Error('boom')
			}),
		).rejects.toThrow('boom')

		expect((await refs(key('a')))?.refs).toBe(1)
		expect(await refs(key('b'))).toBeUndefined()
		expect(await stored('one')).toEqual({ 'a.css': key('a') })
	})

	test('concurrent sites taking the same keys in different orders lose no references and do not deadlock', async () => {
		const letters = ['a', 'b', 'c', 'd', 'e', 'f']
		await Promise.all(
			Array.from({ length: 12 }, (_, index) => {
				const order = index % 2 === 0 ? letters : [...letters].reverse()
				return writeSite(`site-${index}`, Object.fromEntries(order.map((letter) => [`${letter}.css`, key(letter)])))
			}),
		)

		for (const letter of letters) expect((await refs(key(letter)))?.refs).toBe(12)
	})

	test('refcounts always equal the number of sites referencing each key after random concurrent churn', async () => {
		const letters = ['a', 'b', 'c', 'd', 'e', 'f']
		const pick = (seed: number) =>
			Object.fromEntries(
				letters.filter((_, index) => ((seed >> index) & 1) === 1).map((letter) => [`${letter}.css`, key(letter)]),
			)
		// Each site rewrites itself several times; sites overlap in keys and in lock order.
		await Promise.all(
			Array.from({ length: 10 }, async (_, site) => {
				for (let round = 0; round < 6; round++) {
					await writeSite(`churn-${site}`, pick((site * 7 + round * 13 + 5) % 64))
				}
			}),
		)

		const rows = await sql<Array<{ file_objects: FileObjects | null }>>`SELECT file_objects FROM site_cache`
		for (const letter of letters) {
			const expected = rows.filter((row) => Object.values(row.file_objects ?? {}).includes(key(letter))).length
			expect((await refs(key(letter)))?.refs ?? 0).toBe(expected)
		}
	})

	test('concurrent updates of one site serialize on its row', async () => {
		await writeSite('one', { 'a.css': key('a') })
		await Promise.all([
			writeSite('one', { 'b.css': key('b') }),
			writeSite('one', { 'c.css': key('c') }),
			writeSite('one', { 'd.css': key('d') }),
		])

		const final = Object.values((await stored('one')) as FileObjects)
		expect(final).toHaveLength(1)
		let total = 0
		for (const letter of ['a', 'b', 'c', 'd']) total += (await refs(key(letter)))?.refs ?? 0
		expect(total).toBe(1)
		expect((await refs(final[0] as string))?.refs).toBe(1)
	})
})

suite('recordCasObject (postgres)', () => {
	let sql: postgres.Sql
	const refs = async (k: string) =>
		(
			await sql<Array<{ refs: number; size: string | null; unreferenced_at: string | null }>>`
			SELECT refs, size, unreferenced_at FROM cas_objects WHERE key = ${k}
		`
		)[0]

	beforeAll(async () => {
		sql = postgres(url as string, { max: 5, onnotice: () => {}, connection: { search_path: `${schema}_rec` } })
		await sql.unsafe(`CREATE SCHEMA ${schema}_rec`)
		await sql.unsafe(`CREATE TABLE site_cache (did TEXT, rkey TEXT, record_cid TEXT, PRIMARY KEY (did, rkey))`)
		for (const statement of CAS_SCHEMA_STATEMENTS) await sql.unsafe(statement)
	})

	afterAll(async () => {
		await sql.unsafe(`DROP SCHEMA ${schema}_rec CASCADE`)
		await sql.end()
	})

	test('registers a written body as unreferenced so garbage collection can age it', async () => {
		await recordCasObject(sql, key('a'), 123)
		const row = await refs(key('a'))
		expect(row?.refs).toBe(0)
		expect(Number(row?.size)).toBe(123)
		expect(row?.unreferenced_at).not.toBeNull()
	})

	test('registering an unreferenced object again restarts its garbage-collection clock and fills a missing size', async () => {
		await sql`INSERT INTO cas_objects (key, refs, size, unreferenced_at) VALUES (${key('d')}, 0, NULL, 1000)`

		await recordCasObject(sql, key('d'), 77)

		const row2 = await refs(key('d'))
		expect(Number(row2?.unreferenced_at)).toBeGreaterThan(1_000_000)
		expect(Number(row2?.size)).toBe(77)
	})

	test('is idempotent and never resets references already taken', async () => {
		await recordCasObject(sql, key('b'), 5)
		await sql`UPDATE cas_objects SET refs = 3, unreferenced_at = NULL WHERE key = ${key('b')}`
		await recordCasObject(sql, key('b'), 5)

		const row = await refs(key('b'))
		expect(row?.refs).toBe(3)
		expect(row?.unreferenced_at).toBeNull()
	})

	test('rejects a key that is not a CAS key', async () => {
		await expect(recordCasObject(sql, 'did:plc:x/site/index.html', 1)).rejects.toThrow('CAS key')
	})
})

suite('touchCasObjects (postgres)', () => {
	let sql: postgres.Sql
	const row = async (k: string) =>
		(
			await sql<Array<{ refs: number; unreferenced_at: string | null }>>`
			SELECT refs, unreferenced_at FROM cas_objects WHERE key = ${k}
		`
		)[0]

	beforeAll(async () => {
		sql = postgres(url as string, { max: 5, onnotice: () => {}, connection: { search_path: `${schema}_touch` } })
		await sql.unsafe(`CREATE SCHEMA ${schema}_touch`)
		await sql.unsafe(`CREATE TABLE site_cache (did TEXT, rkey TEXT, record_cid TEXT, PRIMARY KEY (did, rkey))`)
		for (const statement of CAS_SCHEMA_STATEMENTS) await sql.unsafe(statement)
	})

	afterAll(async () => {
		await sql.unsafe(`DROP SCHEMA ${schema}_touch CASCADE`)
		await sql.end()
	})

	test('restarts the garbage-collection clock of an unreferenced object', async () => {
		await sql`INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${key('a')}, 0, 1000)`

		expect(await touchCasObjects(sql, [key('a')])).toEqual([key('a')])

		expect(Number((await row(key('a')))?.unreferenced_at)).toBeGreaterThan(1_000_000)
	})

	test('leaves a referenced object alone', async () => {
		await sql`INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${key('b')}, 2, NULL)`

		expect(await touchCasObjects(sql, [key('b')])).toEqual([key('b')])

		const after = await row(key('b'))
		expect(after?.refs).toBe(2)
		expect(after?.unreferenced_at).toBeNull()
	})

	test('reports only the keys that still have a row, never creating one', async () => {
		await sql`INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${key('e')}, 0, 1000)`

		expect(await touchCasObjects(sql, [key('c'), key('e')])).toEqual([key('e')])
		expect(await touchCasObjects(sql, [])).toEqual([])
		expect(await row(key('c'))).toBeUndefined()
	})

	test('rejects a key that is not a CAS key', async () => {
		await expect(touchCasObjects(sql, ['did:plc:x/site/index.html'])).rejects.toThrow('CAS key')
	})
})

suite('migration queries (postgres)', () => {
	let sql: postgres.Sql
	const DELETED = 'deleted-tombstone-cid'

	const refs = async (k: string) =>
		(await sql<Array<{ refs: number }>>`SELECT refs FROM cas_objects WHERE key = ${k}`)[0]?.refs

	const insertSite = (
		rkey: string,
		fileCids: Record<string, string>,
		extra: { did?: string; fileObjects?: FileObjects; absent?: boolean; recordCid?: string } = {},
	) =>
		sql`
			INSERT INTO site_cache (did, rkey, record_cid, file_cids, file_objects, absent_since)
			VALUES (${extra.did ?? DID}, ${rkey}, ${extra.recordCid ?? 'cid'}, ${sql.json(fileCids)},
				${extra.fileObjects ? sql.json(extra.fileObjects) : null}, ${extra.absent ? 1 : null})
		`

	beforeAll(async () => {
		sql = postgres(url as string, { max: 5, onnotice: () => {}, connection: { search_path: `${schema}_mig` } })
		await sql.unsafe(`CREATE SCHEMA ${schema}_mig`)
		await sql.unsafe(`
			CREATE TABLE site_cache (
				did TEXT NOT NULL, rkey TEXT NOT NULL, record_cid TEXT NOT NULL,
				file_cids JSONB NOT NULL DEFAULT '{}', absent_since BIGINT, PRIMARY KEY (did, rkey)
			)
		`)
		for (const statement of CAS_SCHEMA_STATEMENTS) await sql.unsafe(statement)
	})

	afterAll(async () => {
		await sql.unsafe(`DROP SCHEMA ${schema}_mig CASCADE`)
		await sql.end()
	})

	beforeEach(async () => {
		await sql`TRUNCATE site_cache, cas_objects`
	})

	test('lists live sites in did/rkey order, a page at a time, skipping tombstones and absent sites', async () => {
		await insertSite('b', { 'a.css': 'x' })
		await insertSite('a', { 'a.css': 'x' })
		await insertSite('gone', {}, { recordCid: DELETED })
		await insertSite('absent', { 'a.css': 'x' }, { absent: true })
		await insertSite('c', { 'a.css': 'x' }, { did: 'did:plc:zed' })

		const first = await listSitesForMigration(sql, null, 2, DELETED)
		expect(first.map((s) => `${s.did}/${s.rkey}`)).toEqual([`${DID}/a`, `${DID}/b`])

		const last = first[first.length - 1] as { did: string; rkey: string }
		const second = await listSitesForMigration(sql, { did: last.did, rkey: last.rkey }, 2, DELETED)
		expect(second.map((s) => `${s.did}/${s.rkey}`)).toEqual(['did:plc:zed/c'])
	})

	test('returns the stored mapping, or null for a site that has none', async () => {
		await insertSite('plain', { 'a.css': 'x' })
		await insertSite('mapped', { 'a.css': 'x' }, { fileObjects: { 'a.css': key('a') } })

		const sites = await listSitesForMigration(sql, null, 10, DELETED)

		expect(sites.find((s) => s.rkey === 'plain')?.fileObjects).toBeNull()
		expect(sites.find((s) => s.rkey === 'mapped')?.fileObjects).toEqual({ 'a.css': key('a') })
	})

	test('commits a mapping and takes references when the site is unchanged since it was scanned', async () => {
		await insertSite('one', { 'a.css': 'x' })

		const result = await commitMigratedMapping(sql, DID, 'one', { 'a.css': 'x' }, { 'a.css': key('a') })

		expect(result).toBe('committed')
		expect(await refs(key('a'))).toBe(1)
	})

	test('refuses a site whose file CIDs changed after the scan, leaving it untouched', async () => {
		await insertSite('one', { 'a.css': 'newer' })

		const result = await commitMigratedMapping(sql, DID, 'one', { 'a.css': 'x' }, { 'a.css': key('a') })

		expect(result).toBe('stale')
		expect(await refs(key('a'))).toBeUndefined()
	})

	test('refuses a site that no longer exists', async () => {
		expect(await commitMigratedMapping(sql, DID, 'nope', {}, { 'a.css': key('a') })).toBe('stale')
	})

	test('a rerun, or one that maps more files, keeps references exact', async () => {
		await insertSite('one', { 'a.css': 'x', 'b.css': 'y' })
		await commitMigratedMapping(sql, DID, 'one', { 'a.css': 'x', 'b.css': 'y' }, { 'a.css': key('a') })

		expect(await commitMigratedMapping(sql, DID, 'one', { 'a.css': 'x', 'b.css': 'y' }, { 'a.css': key('a') })).toBe(
			'committed',
		)
		expect(await refs(key('a'))).toBe(1)

		await commitMigratedMapping(
			sql,
			DID,
			'one',
			{ 'a.css': 'x', 'b.css': 'y' },
			{ 'a.css': key('a'), 'b.css': key('b') },
		)
		expect(await refs(key('a'))).toBe(1)
		expect(await refs(key('b'))).toBe(1)
	})

	test('never overwrites a mapping the cache writer produced for the same path', async () => {
		await insertSite('one', { 'a.css': 'x' }, { fileObjects: { 'a.css': key('writer') } })

		const result = await commitMigratedMapping(sql, DID, 'one', { 'a.css': 'x' }, { 'a.css': key('a') })

		expect(result).toBe('stale')
		expect(await refs(key('a'))).toBeUndefined()
	})

	test('allows migrating an updated site when old writer left stale file_objects, but refuses a concurrent CAS writer', async () => {
		// Pass 1: site had file 'a.css' -> key('a'). Mapping A is stored via commitMigratedMapping (which creates cas_objects rows).
		await insertSite('update_race', { 'a.css': 'cid_a' })
		await recordCasObject(sql, key('a'), 100)
		await recordCasObject(sql, key('b'), 200)
		const first = await commitMigratedMapping(sql, DID, 'update_race', { 'a.css': 'cid_a' }, { 'a.css': key('a') })
		expect(first).toBe('committed')
		expect(await refs(key('a'))).toBe(1)

		// Old writer updates to 'b.css' -> 'cid_b', but leaves file_objects untouched as { 'a.css': key('a') }.
		await sql`
			UPDATE site_cache
			SET file_cids = ${sql.json({ 'b.css': 'cid_b' })},
			    record_cid = 'cid_2'
			WHERE did = ${DID} AND rkey = 'update_race'
		`

		// Migration pass 2 scanned the updated file_cids ({ 'b.css': 'cid_b' }) and computed mapping { 'b.css': key('b') }.
		const result = await commitMigratedMapping(sql, DID, 'update_race', { 'b.css': 'cid_b' }, { 'b.css': key('b') })
		expect(result).toBe('committed')
		expect(await refs(key('b'))).toBe(1)
		expect(await refs(key('a'))).toBe(0)
	})

	test('refuses to overwrite a mapping that a concurrent CAS writer produced during migration', async () => {
		await insertSite('cas_writer_race', { 'b.css': 'cid_b' }, { fileObjects: { 'b.css': key('writer') } })

		const result = await commitMigratedMapping(
			sql,
			DID,
			'cas_writer_race',
			{ 'b.css': 'cid_b' },
			{ 'b.css': key('migration') },
		)
		expect(result).toBe('stale')
	})
})
