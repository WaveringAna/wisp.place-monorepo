import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { LABELER_SCHEMA_STATEMENTS, MODERATION_SCHEMA_STATEMENTS } from '@wispplace/database'
import postgres from 'postgres'
import { createModerationApi, subjectDid } from './api'
import { createModerationStore, decodeCursor, encodeCursor, siteUri } from './store'
import { createSiteSync, readPublished, siteUrl } from './sync'
import { createTriageWorker, readPage } from './triage'

const LABELER = 'did:plc:labelerlabelerlabelerlab'
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const MOD = 'did:plc:mmmmmmmmmmmmmmmmmmmmmmmm'
const TOKEN = 'briefing-token-briefing-token-briefing-token'

describe('pure helpers', () => {
	test('subjectDid accepts account DIDs and site record URIs only', () => {
		expect(subjectDid(ALICE)).toBe(ALICE)
		expect(subjectDid(siteUri(ALICE, 'shop'))).toBe(ALICE)
		expect(subjectDid(`at://${ALICE}/app.bsky.feed.post/x`)).toBeNull()
		expect(subjectDid('did:plc:short')).toBeNull()
	})

	test('queue cursors round-trip and reject junk', () => {
		const c = encodeCursor('2026-10-16T12:00:00.000Z', siteUri(ALICE, 'a|b'))
		expect(decodeCursor(c)).toEqual({ updated: '2026-10-16T12:00:00.000Z', uri: `at://${ALICE}/place.wisp.fs/a` })
		expect(decodeCursor('nonsense')).toBeNull()
	})

	test('readPage pulls the title, outbound hosts and visible text', () => {
		const page = readPage(
			'<html><head><title>Hi &amp; bye</title><style>x{}</style></head><body><script>evil()</script><h1>Cheap  pills</h1><a href="https://spam.example/x">buy</a><a href="/local">l</a></body></html>',
			3000,
		)
		expect(page.title).toBe('Hi & bye')
		expect(page.outbound).toEqual(['spam.example'])
		expect(page.text).toBe('Cheap pills buy l')
	})

	test('siteUrl prefers a verified custom domain, then a wisp subdomain, then the shared host', () => {
		const base = { did: ALICE, rkey: 'shop', recordCid: 'c', updatedAt: 1, absent: false, files: 1 }
		expect(
			siteUrl({ ...base, custom: ['shop.example'], subdomains: ['alice.wisp.place'] }, 'alice', 'sites.wisp.place'),
		).toBe('https://shop.example/')
		expect(siteUrl({ ...base, custom: [], subdomains: ['alice.wisp.place'] }, 'alice', 'sites.wisp.place')).toBe(
			'https://alice.wisp.place/',
		)
		expect(siteUrl({ ...base, custom: [], subdomains: [] }, 'alice.bsky.social', 'sites.wisp.place')).toBe(
			'https://sites.wisp.place/alice.bsky.social/shop/',
		)
	})
})

// The queue's real behaviour lives in SQL, so it is tested against postgres:
//   WISP_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/test bun test apps/labeler/src/moderation
const url = process.env.WISP_TEST_DATABASE_URL
const suite = url ? describe : describe.skip

suite('moderation (postgres)', () => {
	const schema = `moderation_${Math.random().toString(36).slice(2, 10)}`
	let admin: postgres.Sql
	let sql: postgres.Sql
	let store: ReturnType<typeof createModerationStore>

	beforeAll(async () => {
		admin = postgres(url as string, { max: 1, onnotice: () => {} })
		await admin.unsafe(`CREATE SCHEMA ${schema}`)
		sql = postgres(`${url}${url?.includes('?') ? '&' : '?'}search_path=${schema}`, { max: 2, onnotice: () => {} })
		await sql.unsafe(`CREATE TABLE site_cache (did TEXT, rkey TEXT, record_cid TEXT, file_cids JSONB NOT NULL DEFAULT '{}',
			updated_at BIGINT, absent_since BIGINT, PRIMARY KEY (did, rkey))`)
		await sql.unsafe('CREATE TABLE domains (domain TEXT PRIMARY KEY, did TEXT, rkey TEXT)')
		await sql.unsafe('CREATE TABLE custom_domains (id TEXT, domain TEXT, did TEXT, rkey TEXT, verified BOOLEAN)')
		for (const s of [...LABELER_SCHEMA_STATEMENTS, ...MODERATION_SCHEMA_STATEMENTS]) await sql.unsafe(s)
		store = createModerationStore(sql, LABELER)
	})

	afterAll(async () => {
		await sql.end()
		await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
		await admin.end()
	})

	beforeEach(async () => {
		await sql.unsafe(`TRUNCATE site_cache, domains, custom_domains, labeler_labels, moderation_sites, moderation_verdicts,
			moderation_events, moderation_cursor, moderation_logins`)
	})

	const publish = (
		did: string,
		rkey: string,
		cid: string,
		at: number,
		files: Record<string, string> = { 'index.html': 'x' },
	) => sql`
		INSERT INTO site_cache (did, rkey, record_cid, file_cids, updated_at) VALUES (${did}, ${rkey}, ${cid}, ${sql.json(files)}, ${at})
		ON CONFLICT (did, rkey) DO UPDATE SET record_cid = EXCLUDED.record_cid, updated_at = EXCLUDED.updated_at`
	const sync = () => createSiteSync({ sql, store, resolveHandle: async (did) => (did === ALICE ? 'alice.test' : null) })
	const label = (uri: string, val: string, neg = false) => sql`
		INSERT INTO labeler_labels (src, uri, val, neg, cts, sig)
		VALUES (${LABELER}, ${uri}, ${val}, ${neg}, ${new Date().toISOString()}, ${new Uint8Array(64)})`
	const page = (html: string, status = 200) => (async () => new Response(html, { status })) as unknown as typeof fetch
	const worker = (flag: boolean, fetchImpl: typeof fetch) =>
		createTriageWorker({
			store,
			model: 'test-model',
			fetchImpl,
			classify: async () => ({
				flag,
				category: flag ? 'spam' : 'none',
				reason: flag ? 'doorway' : 'fine',
				confidence: 0.9,
			}),
		})

	test('sync picks up sites with their domains, and only a new record version counts as new', async () => {
		await publish(ALICE, 'shop', 'cid1', 1000)
		await publish(BOB, 'home', 'cid2', 1000)
		await sql`INSERT INTO domains VALUES ('alice.wisp.place', ${ALICE}, 'shop')`
		await sql`INSERT INTO custom_domains VALUES ('h', 'shop.example', ${ALICE}, 'shop', true)`
		await sync().syncAll()
		const alice = await store.site(siteUri(ALICE, 'shop'))
		expect(alice).toMatchObject({ handle: 'alice.test', url: 'https://shop.example/', state: 'pending', files: 1 })
		expect(alice?.domains).toEqual(['shop.example', 'alice.wisp.place'])
		expect((await store.site(siteUri(BOB, 'home')))?.url).toBe(`https://sites.wisp.place/${BOB}/home/`)

		await worker(false, page('<title>t</title><p>hello</p>')).drain()
		await publish(ALICE, 'shop', 'cid1', 2000) // re-cached, same record
		await sync().syncAll()
		expect((await store.site(siteUri(ALICE, 'shop')))?.state).toBe('clear')
		await publish(ALICE, 'shop', 'cid3', 3000) // a new version
		await sync().syncAll()
		expect(await store.site(siteUri(ALICE, 'shop'))).toMatchObject({ state: 'pending', triage: null })
		const seen = (await store.events(null, 50)).items.filter((e) => e.kind === 'seen')
		expect(seen.map((e) => e.subject).sort()).toEqual(
			[siteUri(ALICE, 'shop'), siteUri(ALICE, 'shop'), siteUri(BOB, 'home')].sort(),
		)
	})

	test('a batch boundary inside one second neither skips nor repeats sites', async () => {
		for (const r of ['a', 'b', 'c', 'd', 'e']) await publish(ALICE, r, `cid-${r}`, 5000)
		const first = await readPublished(sql, { updatedAt: 0, did: '', rkey: '' }, 2)
		const last = first[first.length - 1]
		if (!last) throw new Error('empty batch')
		const rest = await readPublished(sql, { updatedAt: last.updatedAt, did: last.did, rkey: last.rkey }, 10)
		expect([...first, ...rest].map((s) => s.rkey)).toEqual(['a', 'b', 'c', 'd', 'e'])
	})

	test('triage flags into the queue; a verdict clears it until the next version; a takedown removes it', async () => {
		await publish(ALICE, 'shop', 'cid1', Math.floor(Date.now() / 1000) - 60)
		await sync().syncAll()
		await worker(
			true,
			page('<title>Casino</title><p>best casino bonus</p><a href="https://casino.example">go</a>'),
		).drain()
		let flagged = await store.queue('flagged', null, 10)
		expect(flagged.items.map((s) => s.uri)).toEqual([siteUri(ALICE, 'shop')])
		expect(flagged.items[0]).toMatchObject({
			title: 'Casino',
			outbound: ['casino.example'],
			triage: { flag: true, category: 'spam', model: 'test-model' },
		})
		expect(await store.counts()).toMatchObject({ flagged: 1, pending: 0, recent: 1, reviewed: 0 })

		await store.setVerdict(ALICE, 'fine', 'their own casino game', MOD)
		expect((await store.queue('flagged', null, 10)).items).toEqual([])
		const reviewed = (await store.queue('reviewed', null, 10)).items[0]
		expect(reviewed?.verdict).toMatchObject({ value: 'fine', scope: 'account', by: MOD })
		expect(reviewed?.state).toBe('reviewed')

		await publish(ALICE, 'shop', 'cid2', Math.floor(Date.now() / 1000) + 60) // published after the verdict
		await sync().syncAll()
		await worker(true, page('<p>now with more casino</p>')).drain()
		flagged = await store.queue('flagged', null, 10)
		expect(flagged.items[0]?.verdict?.value).toBe('fine') // shown for context, but no longer covering
		await label(ALICE, '!takedown')
		expect((await store.queue('flagged', null, 10)).items).toEqual([])
		expect((await store.site(siteUri(ALICE, 'shop')))?.labels.map((l) => l.val)).toEqual(['!takedown'])
		await label(ALICE, '!takedown', true)
		expect((await store.site(siteUri(ALICE, 'shop')))?.labels).toEqual([])
	})

	test('a page that does not answer is retried, then cleared with the status as the reason', async () => {
		await publish(BOB, 'gone', 'cid1', 1000)
		await sync().syncAll()
		const w = worker(true, page('', 503))
		expect(await w.step()).toBe(true)
		expect((await store.site(siteUri(BOB, 'gone')))?.state).toBe('pending')
		for (let i = 0; i < 3; i++) {
			await sql`UPDATE moderation_sites SET triage_after = now()`
			await w.step()
		}
		expect(await store.site(siteUri(BOB, 'gone'))).toMatchObject({
			state: 'clear',
			triage: { reason: 'the page answered 503', model: 'none' },
		})
	})

	test('queue pages by publish time with a cursor', async () => {
		for (let i = 0; i < 5; i++) await publish(ALICE, `s${i}`, `c${i}`, 1000 + i)
		await sync().syncAll()
		const one = await store.queue('pending', null, 2)
		const two = await store.queue('pending', one.cursor, 2)
		const three = await store.queue('pending', two.cursor, 2)
		expect([...one.items, ...two.items, ...three.items].map((s) => s.rkey)).toEqual(['s4', 's3', 's2', 's1', 's0'])
		expect(three.cursor).toBeNull()
	})

	describe('api', () => {
		const emitted: unknown[] = []
		const api = () =>
			createModerationApi({
				store,
				auth: {
					moderator: async (req) => (req.headers.get('cookie') === 'mod' ? MOD : null),
					handle: async () => 'mod.test',
				},
				emitLabel: async (l) => {
					emitted.push(l)
					await label(l.uri, l.val, l.neg)
					return { seq: emitted.length }
				},
				apiToken: TOKEN,
			})
		const call = (handler: (req: Request) => Promise<Response>, path: string, init: RequestInit = {}) =>
			handler(new Request(`https://moderation.test${path}`, init))
		const asMod = { cookie: 'mod' }
		const jsonPost = (body: unknown, headers: Record<string, string>) => ({
			method: 'POST',
			headers: { ...headers, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})

		test('only a moderator or the briefing token gets in, and the token cannot label', async () => {
			const a = api()
			expect((await call(a['/api/queue'].GET, '/api/queue')).status).toBe(401)
			expect(
				(await call(a['/api/queue'].GET, '/api/queue', { headers: { authorization: `Bearer ${TOKEN}` } })).status,
			).toBe(200)
			expect((await call(a['/api/me'].GET, '/api/me', { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(
				401,
			)
			expect(await (await call(a['/api/me'].GET, '/api/me', { headers: asMod })).json()).toEqual({
				did: MOD,
				handle: 'mod.test',
			})
			const tokenLabel = await call(
				a['/api/label'].POST,
				'/api/label',
				jsonPost({ uri: ALICE, val: '!takedown', neg: false }, { authorization: `Bearer ${TOKEN}` }),
			)
			expect(tokenLabel.status).toBe(401)
			const form = await call(a['/api/verdict'].POST, '/api/verdict', {
				method: 'POST',
				headers: { ...asMod, 'content-type': 'application/x-www-form-urlencoded' },
				body: 'uri=x',
			})
			expect(form.status).toBe(415)
		})

		test('a verdict returns the updated site; a label is signed, logged and returned', async () => {
			await publish(ALICE, 'shop', 'cid1', 1000)
			await sync().syncAll()
			const a = api()
			const verdict = await call(
				a['/api/verdict'].POST,
				'/api/verdict',
				jsonPost({ uri: siteUri(ALICE, 'shop'), verdict: 'spam', note: 'doorway' }, asMod),
			)
			expect((await verdict.json()).site).toMatchObject({
				state: 'reviewed',
				verdict: { value: 'spam', note: 'doorway', scope: 'site', by: MOD },
			})
			const bad = await call(
				a['/api/verdict'].POST,
				'/api/verdict',
				jsonPost({ uri: siteUri(ALICE, 'shop'), verdict: 'evil' }, asMod),
			)
			expect(bad.status).toBe(400)

			const res = await call(
				a['/api/label'].POST,
				'/api/label',
				jsonPost({ uri: siteUri(ALICE, 'shop'), val: '!takedown', neg: false, note: 'doorway' }, asMod),
			)
			expect((await res.json()).labels.map((l: { val: string }) => l.val)).toEqual(['!takedown'])
			expect(emitted[emitted.length - 1]).toEqual({ uri: siteUri(ALICE, 'shop'), val: '!takedown', neg: false, note: 'doorway' })
			const kinds = (await store.events(null, 10, ALICE)).items.map((e) => [e.kind, e.actor])
			expect(kinds.slice(0, 2)).toEqual([
				['label', MOD],
				['verdict', MOD],
			])
		})
	})
})
