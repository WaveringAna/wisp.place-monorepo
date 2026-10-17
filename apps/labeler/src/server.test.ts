import { afterEach, describe, expect, test } from 'bun:test'
import { Secp256k1Keypair } from '@atproto/crypto'
import { decodeAll } from '@atproto/lex-cbor'
import { DEFAULT_LABEL_VALUES } from './config'
import { verifyLabel } from './labels'
import { createLabeler } from './server'
import { createMemoryLabelStore, type LabelStore } from './store'

const DID = 'did:plc:25fzqofm2xkx27bcaicxbyxk'
const TOKEN = 'test-admin-token-that-is-long-enough-1234'
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const SITE = `at://${ALICE}/place.wisp.fs/shop`

type Frame = { header: { op: number; t?: string }; body: any }

const servers: { stop(force?: boolean): unknown }[] = []
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true)
})

async function start(store: LabelStore = createMemoryLabelStore()) {
	const keypair = await Secp256k1Keypair.create()
	const labeler = createLabeler({ did: DID, keypair, store, values: DEFAULT_LABEL_VALUES, adminToken: TOKEN })
	const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: labeler.fetch, websocket: labeler.websocket })
	servers.push(server)
	const base = `http://127.0.0.1:${server.port}`
	const admin = (body: unknown, token = TOKEN) =>
		fetch(`${base}/admin/labels`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		})
	return { labeler, keypair, base, admin }
}

/** Open subscribeLabels and collect decoded frames until `count` have arrived or the socket closes. */
function subscribe(base: string, query = '') {
	const frames: Frame[] = []
	const waiters: (() => void)[] = []
	let closed: { code: number } | null = null
	const ws = new WebSocket(`${base.replace('http', 'ws')}/xrpc/com.atproto.label.subscribeLabels${query}`)
	ws.binaryType = 'arraybuffer'
	const opened = new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve()
		ws.onerror = () => reject(new Error('socket error'))
	})
	const wake = () => {
		for (const w of waiters.splice(0)) w()
	}
	ws.onmessage = (event) => {
		const [header, body] = [...decodeAll(new Uint8Array(event.data as ArrayBuffer))] as [Frame['header'], unknown]
		frames.push({ header, body })
		wake()
	}
	ws.onclose = (event) => {
		closed = { code: event.code }
		wake()
	}
	const until = async (count: number) => {
		const deadline = Date.now() + 3000
		while (frames.length < count && !closed && Date.now() < deadline)
			await new Promise<void>((resolve) => {
				waiters.push(resolve)
				setTimeout(resolve, 50)
			})
		return frames
	}
	return { ws, opened, frames, until, closed: () => closed }
}

describe('admin API', () => {
	test('refuses a missing or wrong token and anything that is not a declared label', async () => {
		const { admin } = await start()
		expect((await admin({ uri: ALICE, val: '!takedown' }, 'wrong')).status).toBe(401)
		expect((await admin({ uri: ALICE, val: 'porn' })).status).toBe(400)
		expect((await admin({ uri: 'https://example.com', val: '!takedown' })).status).toBe(400)
		expect((await admin({ uri: ALICE, val: '!takedown', exp: '2000-01-01T00:00:00.000Z' })).status).toBe(400)
		expect((await admin({ uri: ALICE, val: '!takedown', cid: 'bafyreigh2akiscaildc' })).status).toBe(400)
	})

	test('signs, stores and returns the label with its sequence number, keeping the note private', async () => {
		const store = createMemoryLabelStore()
		const { admin, keypair } = await start(store)
		const res = await admin({ uri: SITE, val: '!takedown', note: 'phishing kit' })
		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json).toMatchObject({ ver: 1, src: DID, uri: SITE, val: '!takedown' })
		expect(json.note).toBeUndefined()
		expect(store.notes.get(1)).toBe('phishing kit')
		const [stored] = await store.after(0, 10)
		if (!stored) throw new Error('nothing stored')
		const { seq: _seq, ...label } = stored
		expect(await verifyLabel(label, keypair.did())).toBe(true)
	})
})

describe('queryLabels', () => {
	test('answers the newest label per subject and value, negations included, by exact uri or prefix', async () => {
		const { admin, base } = await start()
		await admin({ uri: ALICE, val: 'spam' })
		await admin({ uri: SITE, val: '!takedown' })
		await admin({ uri: SITE, val: '!takedown', neg: true })
		const bySite = await (await fetch(`${base}/xrpc/com.atproto.label.queryLabels?uriPatterns=${SITE}`)).json()
		expect(bySite.labels).toHaveLength(1)
		expect(bySite.labels[0]).toMatchObject({ uri: SITE, val: '!takedown', neg: true })
		expect(typeof bySite.labels[0].sig.$bytes).toBe('string')
		const byPrefix = await (
			await fetch(`${base}/xrpc/com.atproto.label.queryLabels?uriPatterns=${encodeURIComponent('at://*')}`)
		).json()
		expect(byPrefix.labels.map((l: { uri: string }) => l.uri)).toEqual([SITE])
		const otherSource = await (
			await fetch(`${base}/xrpc/com.atproto.label.queryLabels?uriPatterns=*&sources=did:plc:other`)
		).json()
		expect(otherSource.labels).toEqual([])
	})

	test('pages with a cursor and rejects requests without uriPatterns', async () => {
		const { admin, base } = await start()
		for (const val of ['spam', 'mass-created', '!hide']) await admin({ uri: ALICE, val })
		const first = await (await fetch(`${base}/xrpc/com.atproto.label.queryLabels?uriPatterns=*&limit=2`)).json()
		expect(first.labels.map((l: { val: string }) => l.val)).toEqual(['spam', 'mass-created'])
		const second = await (
			await fetch(`${base}/xrpc/com.atproto.label.queryLabels?uriPatterns=*&limit=2&cursor=${first.cursor}`)
		).json()
		expect(second.labels.map((l: { val: string }) => l.val)).toEqual(['!hide'])
		expect(second.cursor).toBeUndefined()
		expect((await fetch(`${base}/xrpc/com.atproto.label.queryLabels`)).status).toBe(400)
	})

	test('answers other origins, preflight included, but the admin route stays without CORS', async () => {
		const { base } = await start()
		const query = `${base}/xrpc/com.atproto.label.queryLabels?uriPatterns=*`
		const res = await fetch(query, { headers: { origin: 'https://pds.ls' } })
		expect(res.headers.get('access-control-allow-origin')).toBe('*')
		const preflight = await fetch(query, {
			method: 'OPTIONS',
			headers: { origin: 'https://pds.ls', 'access-control-request-method': 'GET' },
		})
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get('access-control-allow-methods')).toContain('GET')
		const admin = await fetch(`${base}/admin/labels`, { method: 'POST', headers: { origin: 'https://pds.ls' } })
		expect(admin.headers.get('access-control-allow-origin')).toBeNull()
	})
})

describe('subscribeLabels', () => {
	test('replays the log after the cursor, then streams new labels, each signed', async () => {
		const { admin, base, keypair } = await start()
		await admin({ uri: ALICE, val: 'spam' })
		await admin({ uri: SITE, val: '!takedown' })
		const sub = subscribe(base, '?cursor=0')
		await sub.opened
		await sub.until(2)
		await admin({ uri: SITE, val: '!takedown', neg: true })
		const frames = await sub.until(3)
		expect(frames.map((f) => [f.header.t, f.body.seq])).toEqual([
			['#labels', 1],
			['#labels', 2],
			['#labels', 3],
		])
		const [label] = frames[2]?.body.labels ?? []
		expect(label).toMatchObject({ uri: SITE, val: '!takedown', neg: true })
		expect(await verifyLabel(label, keypair.did())).toBe(true)
		sub.ws.close()
	})

	test('without a cursor starts at the live head', async () => {
		const { admin, base, labeler } = await start()
		await admin({ uri: ALICE, val: 'spam' })
		const sub = subscribe(base)
		await sub.opened
		while (labeler.subscriberCount() === 0) await Bun.sleep(5)
		await Bun.sleep(20)
		await admin({ uri: ALICE, val: '!hide' })
		const frames = await sub.until(1)
		expect(frames.map((f) => f.body.seq)).toEqual([2])
		sub.ws.close()
	})

	test('a cursor past the head gets FutureCursor and a close', async () => {
		const { base } = await start()
		const sub = subscribe(base, '?cursor=99')
		await sub.opened
		const frames = await sub.until(1)
		expect(frames[0]).toEqual({ header: { op: -1 }, body: { error: 'FutureCursor', message: expect.any(String) } })
		await sub.until(2)
		expect(sub.closed()?.code).toBe(1008)
	})

	test('a label written while the backfill is being read arrives once, in order', async () => {
		const inner = createMemoryLabelStore()
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let gated = true
		const store: LabelStore = {
			...inner,
			append: inner.append,
			async after(cursor, limit) {
				const page = await inner.after(cursor, limit)
				if (gated) {
					gated = false
					await gate
				}
				return page
			},
		}
		const { admin, base } = await start(store)
		await admin({ uri: ALICE, val: 'spam' })
		const sub = subscribe(base, '?cursor=0')
		await sub.opened
		await Bun.sleep(20)
		await admin({ uri: ALICE, val: '!hide' })
		release()
		const frames = await sub.until(2)
		await Bun.sleep(50)
		expect(frames.map((f) => f.body.seq)).toEqual([1, 2])
		sub.ws.close()
	})
})
