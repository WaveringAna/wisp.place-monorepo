import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { CAS_SCHEMA_STATEMENTS } from '@wispplace/database'
import { casKey, type FileObjects } from '@wispplace/fs-utils'
import postgres from 'postgres'
import { collectGarbage, reconcileCasReferences } from './cas-gc'
import { applyCasReferences, recordCasObject, touchCasObjects } from './cas-objects'

// Garbage collection deletes data, so these run against a real Postgres where the guarantees live:
// row locks, re-checks under lock and concurrent writers. Throw-away schema, never the real tables:
//   WISP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/wisp bun test src/lib/cas-gc.pg.test.ts
const url = process.env.WISP_TEST_DATABASE_URL
const suite = url ? describe : describe.skip

const schema = `cas_gc_${Math.random().toString(36).slice(2, 10)}`
const key = (letter: string) => casKey({ cid: `bafkrei${letter.repeat(52)}`, path: 'x.css', mimeType: 'text/css' })
const DID = 'did:plc:test'
const NOW = 2_000_000
const GRACE = 86_400
const OLD = NOW - GRACE - 1_000
const RECENT = NOW - 60

suite('cas garbage collection (postgres)', () => {
	let sql: postgres.Sql
	let deleted: string[]
	let failDeleteOf: Set<string>

	const ports = {
		deleteObject: async (objectKey: string) => {
			if (failDeleteOf.has(objectKey)) throw new Error('storage unavailable')
			deleted.push(objectKey)
		},
	}
	const gc = (extra: Parameters<typeof collectGarbage>[2] extends infer O ? Partial<O> : never = {}) =>
		collectGarbage(sql, ports, { graceSeconds: GRACE, limit: 100, nowSeconds: NOW, ...extra })
	const row = async (k: string) =>
		(
			await sql<Array<{ refs: number; unreferenced_at: string | null }>>`
			SELECT refs, unreferenced_at FROM cas_objects WHERE key = ${k}
		`
		)[0]
	const put = (k: string, refs: number, unreferencedAt: number | null) =>
		sql`INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${k}, ${refs}, ${unreferencedAt})`
	const site = (rkey: string, objects: FileObjects | null) =>
		sql.begin(async (tx) => {
			await tx`INSERT INTO site_cache (did, rkey, record_cid) VALUES (${DID}, ${rkey}, 'cid') ON CONFLICT DO NOTHING`
			await applyCasReferences(tx as unknown as postgres.Sql, DID, rkey, objects)
		})

	beforeAll(async () => {
		sql = postgres(url as string, { max: 10, onnotice: () => {}, connection: { search_path: schema } })
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
		deleted = []
		failDeleteOf = new Set()
	})

	test('deletes an unreferenced object past the grace period, from storage and from the table', async () => {
		await put(key('a'), 0, OLD)

		expect(await gc()).toEqual({ deleted: 1, skipped: 0, failed: 0 })

		expect(deleted).toEqual([key('a')])
		expect(await row(key('a'))).toBeUndefined()
	})

	test('keeps an object any site references, whatever its timestamp says', async () => {
		await put(key('a'), 1, OLD)
		await put(key('b'), 3, null)

		expect((await gc()).deleted).toBe(0)

		expect(deleted).toEqual([])
		expect(await row(key('a'))).toBeDefined()
	})

	test('keeps an unreferenced object younger than the grace period', async () => {
		await put(key('a'), 0, RECENT)

		expect((await gc()).deleted).toBe(0)

		expect(deleted).toEqual([])
		expect(await row(key('a'))).toBeDefined()
	})

	test('keeps an object that a site referenced after it was selected for deletion', async () => {
		await put(key('a'), 0, OLD)

		const result = await gc({
			afterSelect: async () => {
				await site('one', { 'a.css': key('a') })
			},
		})

		expect(result).toMatchObject({ deleted: 0, skipped: 1 })
		expect(deleted).toEqual([])
		expect((await row(key('a')))?.refs).toBe(1)
	})

	test('keeps an object a site update is reusing, which restarted its clock after selection', async () => {
		await put(key('a'), 0, OLD)

		const result = await gc({
			afterSelect: async () => {
				await touchCasObjects(sql, [key('a')])
			},
		})

		expect(result).toMatchObject({ deleted: 0, skipped: 1 })
		expect(deleted).toEqual([])
		expect(await row(key('a'))).toBeDefined()
	})

	test('keeps an object a writer re-registered after selection', async () => {
		await put(key('a'), 0, OLD)

		await gc({
			afterSelect: async () => {
				await recordCasObject(sql, key('a'), 10)
			},
		})

		expect(deleted).toEqual([])
	})

	test('skips, rather than waits for, an object another transaction is holding', async () => {
		await put(key('a'), 0, OLD)
		let release: () => void = () => {}
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let locked: () => void = () => {}
		const lockTaken = new Promise<void>((resolve) => {
			locked = resolve
		})
		const holder = sql.begin(async (tx) => {
			await tx`SELECT key FROM cas_objects WHERE key = ${key('a')} FOR UPDATE`
			locked()
			await held
		})
		await lockTaken

		const result = await gc()
		release()
		await holder

		expect(result).toMatchObject({ deleted: 0, skipped: 1 })
		expect(deleted).toEqual([])
	})

	test('leaves the row when storage cannot delete the object, and a later run finishes the job', async () => {
		await put(key('a'), 0, OLD)
		failDeleteOf.add(key('a'))

		const first = await gc()
		expect(first).toMatchObject({ deleted: 0, failed: 1 })
		expect(await row(key('a'))).toBeDefined()

		failDeleteOf.clear()
		expect((await gc()).deleted).toBe(1)
		expect(await row(key('a'))).toBeUndefined()
	})

	test('removes the row of an object storage no longer has', async () => {
		await put(key('a'), 0, OLD)

		expect((await gc()).deleted).toBe(1)
	})

	test('takes the oldest first and at most the batch limit', async () => {
		await put(key('a'), 0, OLD)
		await put(key('b'), 0, OLD - 500)
		await put(key('c'), 0, OLD - 900)

		await gc({ limit: 2 })

		expect(deleted.sort()).toEqual([key('b'), key('c')].sort())
		expect(await row(key('a'))).toBeDefined()
	})

	test('a referenced-then-released object waits out a fresh grace period', async () => {
		await site('one', { 'a.css': key('a') })
		await site('one', {})

		expect((await row(key('a')))?.refs).toBe(0)
		expect((await collectGarbage(sql, ports, { graceSeconds: GRACE, limit: 10 })).deleted).toBe(0)
	})
})

suite('cas reference reconcile (postgres)', () => {
	let sql: postgres.Sql
	const rs = `${schema}_rec`

	const refs = async (k: string) =>
		(
			await sql<Array<{ refs: number; unreferenced_at: string | null; size: string | null }>>`
			SELECT refs, unreferenced_at, size FROM cas_objects WHERE key = ${k}
		`
		)[0]
	const mappedSite = (rkey: string, objects: unknown, did = DID) =>
		sql`INSERT INTO site_cache (did, rkey, record_cid, file_objects) VALUES (${did}, ${rkey}, 'cid', ${objects === null ? null : sql.json(objects as never)})`

	beforeAll(async () => {
		sql = postgres(url as string, { max: 5, onnotice: () => {}, connection: { search_path: rs } })
		await sql.unsafe(`CREATE SCHEMA ${rs}`)
		await sql.unsafe(`
			CREATE TABLE site_cache (
				did TEXT NOT NULL, rkey TEXT NOT NULL, record_cid TEXT NOT NULL,
				file_cids JSONB NOT NULL DEFAULT '{}', PRIMARY KEY (did, rkey)
			)
		`)
		for (const statement of CAS_SCHEMA_STATEMENTS) await sql.unsafe(statement)
	})

	afterAll(async () => {
		await sql.unsafe(`DROP SCHEMA ${rs} CASCADE`)
		await sql.end()
	})

	beforeEach(async () => {
		await sql`TRUNCATE site_cache, cas_objects`
	})

	test('leaves correct counts untouched', async () => {
		await mappedSite('one', { 'a.css': key('a') })
		await sql`INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${key('a')}, 1, NULL)`

		expect(await reconcileCasReferences(sql, { limit: 100, nowSeconds: NOW })).toMatchObject({ repaired: 0 })
		expect((await refs(key('a')))?.refs).toBe(1)
	})

	test('corrects counts that are too high or too low', async () => {
		await mappedSite('one', { 'a.css': key('a'), 'b.css': key('b') })
		await mappedSite('two', { 'a.css': key('a') })
		await sql`INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${key('a')}, 5, NULL), (${key('b')}, 0, ${OLD})`

		const result = await reconcileCasReferences(sql, { limit: 100, nowSeconds: NOW })

		expect(result.repaired).toBe(2)
		expect((await refs(key('a')))?.refs).toBe(2)
		const b = await refs(key('b'))
		expect(b?.refs).toBe(1)
		expect(b?.unreferenced_at).toBeNull()
	})

	test('counts a site once however many paths use a key, and ignores sites with no mapping', async () => {
		await mappedSite('one', { 'a.css': key('a'), 'copy/a.css': key('a') })
		await mappedSite('legacy', null)
		await mappedSite('empty', {})

		await reconcileCasReferences(sql, { limit: 100, nowSeconds: NOW })

		expect((await refs(key('a')))?.refs).toBe(1)
	})

	test('creates the row of a referenced object that has none', async () => {
		await mappedSite('one', { 'a.css': key('a') })

		const result = await reconcileCasReferences(sql, { limit: 100, nowSeconds: NOW })

		expect(result).toMatchObject({ repaired: 1 })
		expect((await refs(key('a')))?.refs).toBe(1)
	})

	test('releases an object no site references and starts its grace period', async () => {
		await sql`INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${key('a')}, 2, NULL)`

		await reconcileCasReferences(sql, { limit: 100, nowSeconds: NOW })

		const after = await refs(key('a'))
		expect(after?.refs).toBe(0)
		expect(Number(after?.unreferenced_at)).toBe(NOW)
	})

	test('never overwrites a count that changed after its snapshot', async () => {
		await mappedSite('one', { 'a.css': key('a') })
		await sql`INSERT INTO cas_objects (key, refs, unreferenced_at) VALUES (${key('a')}, 0, ${OLD})`

		const result = await reconcileCasReferences(sql, {
			limit: 100,
			nowSeconds: NOW,
			afterSnapshot: async () => {
				await sql`UPDATE cas_objects SET refs = 1, unreferenced_at = NULL WHERE key = ${key('a')}`
			},
		})

		expect(result).toMatchObject({ repaired: 0, raced: 1 })
		expect((await refs(key('a')))?.refs).toBe(1)
	})

	test('ignores a malformed mapping instead of failing the whole pass', async () => {
		await mappedSite('bad', ['not', 'an', 'object'])
		await mappedSite('good', { 'a.css': key('a') })

		await reconcileCasReferences(sql, { limit: 100, nowSeconds: NOW })

		expect((await refs(key('a')))?.refs).toBe(1)
	})

	test('stops at its limit and finishes the rest on the next pass', async () => {
		await mappedSite('one', { 'a.css': key('a'), 'b.css': key('b'), 'c.css': key('c') })

		expect((await reconcileCasReferences(sql, { limit: 2, nowSeconds: NOW })).repaired).toBe(2)
		expect((await reconcileCasReferences(sql, { limit: 2, nowSeconds: NOW })).repaired).toBe(1)
	})
})
