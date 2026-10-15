import '../test-env'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'

// The module binds its connection at import, so point it at a throwaway schema first:
//   WISP_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/wisp bun test --isolate src/lib/db.cursors.pg.test.ts
const url = process.env.WISP_TEST_DATABASE_URL
const schema = `wh_cursors_${Math.random().toString(36).slice(2, 10)}`
if (url) process.env.DATABASE_URL = `${url}${url.includes('?') ? '&' : '?'}search_path=${schema}`
const { closeDatabase, loadJetstreamCursor, runDatabaseMigrations, saveJetstreamCursor } = await import('./db')

const suite = url ? describe : describe.skip
const EAST = 'wss://jetstream2.us-east.bsky.network/subscribe'
const WEST = 'wss://jetstream2.us-west.bsky.network/subscribe'
const T = 1_792_000_000_000_000

suite('jetstream cursors across relays (postgres)', () => {
	let admin: SQL

	beforeAll(async () => {
		admin = new SQL(url as string)
		await admin.unsafe(`CREATE SCHEMA ${schema}`)
		await runDatabaseMigrations()
	})

	afterAll(async () => {
		await closeDatabase()
		await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
		await admin.close()
	})

	test('a relay switch resumes from the last relay, rewound to cover time_us skew', async () => {
		expect(await loadJetstreamCursor('backlink', EAST)).toBeUndefined()
		await saveJetstreamCursor('backlink', EAST, T)
		expect(await loadJetstreamCursor('backlink', EAST)).toBe(T - 2_000_000)
		expect(await loadJetstreamCursor('backlink', WEST)).toBe(T - 60_000_000)
		// Other consumers keep their own cursors.
		expect(await loadJetstreamCursor('direct', WEST)).toBeUndefined()
	})

	test("switching back resumes from the newest progress, not the relay's old row", async () => {
		await saveJetstreamCursor('registry', EAST, T)
		await Bun.sleep(5)
		await saveJetstreamCursor('registry', WEST, T + 3_600_000_000)
		expect(await loadJetstreamCursor('registry', WEST)).toBe(T + 3_600_000_000 - 2_000_000)
		expect(await loadJetstreamCursor('registry', EAST)).toBe(T + 3_600_000_000 - 60_000_000)
	})
})
