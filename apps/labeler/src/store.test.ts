import { afterAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import type { SignedLabel } from './labels'
import { createMemoryLabelStore, createPostgresLabelStore, type LabelStore, migrateLabelStore } from './store'

const SRC = 'did:plc:25fzqofm2xkx27bcaicxbyxk'
const sig = new Uint8Array(64).fill(7)
const label = (uri: string, val: string, extra: Partial<SignedLabel> = {}): SignedLabel => ({
	ver: 1,
	src: SRC,
	uri,
	val,
	cts: '2026-10-16T12:00:00.000Z',
	sig,
	...extra,
})

function contract(name: string, open: () => Promise<LabelStore>) {
	describe(name, () => {
		test('appends in order and reads the log back after a cursor', async () => {
			const store = await open()
			const a = await store.append(label('did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', 'spam'), 'n1')
			const b = await store.append(
				label('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/place.wisp.fs/x', '!takedown', {
					cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm',
					exp: '2030-01-01T00:00:00.000Z',
				}),
				'',
			)
			expect(b.seq).toBeGreaterThan(a.seq)
			expect(await store.latestSeq()).toBe(b.seq)
			const log = await store.after(a.seq - 1, 10)
			expect(log).toEqual([a, b])
			expect(log[1]?.sig).toEqual(sig)
			expect(log[0]).not.toHaveProperty('neg')
			expect(log[0]).not.toHaveProperty('cid')
			expect(await store.after(b.seq, 10)).toEqual([])
		})

		test('current keeps the newest label per uri and value, negations included', async () => {
			const store = await open()
			const uri = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
			await store.append(label(uri, '!takedown'), '')
			const neg = await store.append(label(uri, '!takedown', { neg: true }), '')
			const spam = await store.append(label(uri, 'spam'), '')
			await store.append(label('did:plc:cccccccccccccccccccccccc', 'spam'), '')
			expect(await store.current([uri], 0, 10)).toEqual([neg, spam])
			expect((await store.current(['did:plc:b*'], 0, 10)).map((l) => l.seq)).toEqual([neg.seq, spam.seq])
			expect(await store.current([uri], neg.seq, 10)).toEqual([spam])
			// LIKE wildcards in a pattern are literal
			expect(await store.current(['did:plc:%'], 0, 10)).toEqual([])
		})
	})
}

contract('memory label store', async () => createMemoryLabelStore())

const databaseUrl = process.env.WISP_TEST_DATABASE_URL
const sql = databaseUrl ? postgres(databaseUrl, { max: 2, onnotice: () => {} }) : null
afterAll(async () => {
	await sql?.end({ timeout: 5 })
})

if (sql) {
	contract('postgres label store', async () => {
		await sql`DROP TABLE IF EXISTS labeler_labels`
		await migrateLabelStore(sql)
		await migrateLabelStore(sql)
		return createPostgresLabelStore(sql, SRC)
	})
} else {
	test.skip('postgres label store (set WISP_TEST_DATABASE_URL)', () => {})
}
