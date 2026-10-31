import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSubscribeRepos, parseEventLog, type SubscribeReposDeps } from './lib/subscribe-repos'
import { createApp, resolveHostConfig } from './server'

const ALICE = 'did:plc:abcdefghijklmnopqrstuvwx'
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const PATH = '/xrpc/com.atproto.sync.subscribeRepos'
const OPT_IN = `${PATH}  wisp:firehose  200\n`
const BRIDGE = 'wss://bridge.example.net/xrpc/com.atproto.sync.subscribeRepos'

const SITES: Record<string, { did: string; rkey: string }> = {
	'feed.example.com': { did: ALICE, rkey: 'feed' },
	'bridged.example.com': { did: ALICE, rkey: 'bridged' },
	'nolog.example.com': { did: ALICE, rkey: 'nolog' },
	'bob.example.com': { did: BOB, rkey: 'feed' },
}

const files = new Map<string, Uint8Array<ArrayBuffer>>()
const fromCache: string[] = []

const frame = (name: string | number) => new TextEncoder().encode(`frame ${name}`)
const entry = (seq: number) => ({ seq, type: '#commit', file: `${seq}.cbor` })
const index = (head: number, replayableFrom: number, seqs: number[]) => ({
	version: 1,
	did: 'did:web:feed.example.com',
	head,
	replayable_from: replayableFrom,
	checkpoint: 'checkpoint.cbor',
	events: seqs.map(entry),
})

function put(did: string, rkey: string, path: string, body: string | Uint8Array<ArrayBuffer>): void {
	files.set(`${did}/${rkey}/${path}`, typeof body === 'string' ? new TextEncoder().encode(body) : body)
}

/** Deploy an at-sdp event log: head.json, its frames and the checkpoint. */
function deployLog(did: string, rkey: string, head: number, replayableFrom: number, seqs: number[]): void {
	put(did, rkey, 'xrpc/_sdp/events/head.json', JSON.stringify(index(head, replayableFrom, seqs)))
	put(did, rkey, 'xrpc/_sdp/events/checkpoint.cbor', frame('checkpoint'))
	for (const seq of seqs) put(did, rkey, `xrpc/_sdp/events/${seq}.cbor`, frame(seq))
}

const serveFile: SubscribeReposDeps['serveFile'] = async (did, rkey, path) => {
	const body = files.get(`${did}/${rkey}/${path}`)
	return body ? new Response(body) : new Response('Not found', { status: 404 })
}

const serveSite = async (did: string, rkey: string, path: string) => {
	fromCache.push(`${did}/${rkey}/${path}`)
	return rkey === 'bridged'
		? new Response(null, { status: 302, headers: { location: BRIDGE } })
		: new Response('Not found', { status: 404 })
}

const cleanups: Array<() => void> = []
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
	files.clear()
	fromCache.length = 0
})

function start(options: Partial<SubscribeReposDeps> = {}) {
	const subscribeRepos = createSubscribeRepos({
		serveFile,
		isSupporter: async (did) => did === ALICE,
		reloadDelayMs: 10,
		...options,
	})
	const app = createApp({
		hosts: resolveHostConfig({ BASE_HOST: 'wisp.place' }),
		getWispDomain: async (domain) => (domain === 'feed.wisp.place' ? (SITES['feed.example.com'] ?? null) : null),
		getCustomDomain: async (domain) => SITES[domain] ?? null,
		getCustomDomainByHash: async () => null,
		serveFromCache: serveSite,
		serveFromCacheWithRewrite: serveSite,
		isTakenDown: () => false,
		metrics: { recordHostingResponse: () => {}, recordHostingNotFound: () => {} },
		notFoundLog: { record: () => {} },
		subscribeRepos,
	})
	const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch, websocket: subscribeRepos.websocket })
	cleanups.push(() => {
		subscribeRepos.closeAll()
		server.stop(true)
	})
	return { subscribeRepos, port: server.port }
}

// Bun's WebSocket takes request headers; the DOM typings the project also loads do not know that.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket

/** Dial subscribeRepos as a relay does, collecting every binary message. */
function dial(port: number | undefined, host: string, query = '', client = '192.0.2.1') {
	const frames: Uint8Array[] = []
	const ws = new BunWebSocket(`ws://127.0.0.1:${port}${PATH}${query}`, { headers: { host, 'x-forwarded-for': client } })
	ws.binaryType = 'arraybuffer'
	const opened = new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve()
		ws.onerror = () => reject(new Error(`dial ${host}${query} failed`))
	})
	ws.onmessage = (event) => frames.push(new Uint8Array(event.data as ArrayBuffer))
	return { opened, frames }
}

/** A relay's upgrade request, for the answers it gets instead of a socket. */
function handshake(port: number | undefined, host: string, query = '', client = '192.0.2.1') {
	return fetch(`http://127.0.0.1:${port}${PATH}${query}`, {
		redirect: 'manual',
		headers: {
			host,
			upgrade: 'websocket',
			connection: 'Upgrade',
			'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
			'sec-websocket-version': '13',
			'x-forwarded-for': client,
		},
	})
}

async function eventually(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000
	while (!check() && Date.now() < deadline) await Bun.sleep(5)
}

/** The close code on the wire after `close()`, read off a raw socket: Bun 1.3's WebSocket client reports 1001 as 1000. */
async function closeCodeOnTheWire(port: number | undefined, host: string, close: () => void) {
	let received = Buffer.alloc(0)
	const socket = await Bun.connect({
		hostname: '127.0.0.1',
		port: port as number,
		socket: {
			data(_, chunk) {
				received = Buffer.concat([received, chunk])
			},
		},
	})
	socket.write(
		`GET ${PATH}?cursor=5 HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
			'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
	)
	const frameAt = () => received.indexOf('\r\n\r\n') + 4
	await eventually(() => frameAt() > 3)
	close()
	await eventually(() => received.length >= frameAt() + 4)
	socket.end()
	const frame = received.subarray(frameAt())
	return { status: received.subarray(0, 12).toString(), code: frame[0] === 0x88 ? frame.readUInt16BE(2) : undefined }
}

describe('subscribeRepos on a supporter custom domain that opted in', () => {
	beforeEach(() => {
		put(ALICE, 'feed', '_redirects', OPT_IN)
		deployLog(ALICE, 'feed', 5, 2, [3, 4, 5])
	})

	test('each cursor gets the frames at-sdp would send, then every client tails the next deploy', async () => {
		const { port, subscribeRepos } = start()
		const cases: Array<[string, Uint8Array[]]> = [
			['', [frame('checkpoint')]],
			['?cursor=0', [frame('checkpoint')]],
			['?cursor=1', [frame('checkpoint')]],
			['?cursor=2', [frame(3), frame(4), frame(5)]],
			['?cursor=4', [frame(5)]],
			['?cursor=5', []],
			['?cursor=6', []],
		]

		const clients = cases.map(([query], i) => dial(port, 'feed.example.com', query, `192.0.2.${i + 1}`))
		await Promise.all(clients.map((client) => client.opened))
		await eventually(() => clients.every((client, i) => client.frames.length >= (cases[i]?.[1].length ?? 0)))
		expect(clients.map((client) => client.frames)).toEqual(cases.map(([, frames]) => frames))
		// Past the reload a site's first subscriber schedules, so only siteUpdated can bring the next deploy.
		await Bun.sleep(50)

		deployLog(ALICE, 'feed', 100, 2, [3, 4, 5, 100])
		subscribeRepos.siteUpdated(ALICE, 'feed')
		await eventually(() => clients.every((client, i) => client.frames.length > (cases[i]?.[1].length ?? 0)))
		expect(clients.map((client, i) => client.frames.slice(cases[i]?.[1].length))).toEqual(cases.map(() => [frame(100)]))
	})

	test("a site's first subscriber gets the deploy that was still settling when it dialled", async () => {
		const { port } = start({ reloadDelayMs: 500 })
		const client = dial(port, 'feed.example.com', '?cursor=5')
		await client.opened
		// Nobody followed the site when its update fired, and the dial read the log the update replaced.
		deployLog(ALICE, 'feed', 100, 2, [3, 4, 5, 100])

		await eventually(() => client.frames.length > 0)
		expect(client.frames).toEqual([frame(100)])
	})

	test('dropping the opt-in stops new frames without closing the socket, and adding it back resumes them', async () => {
		const { port, subscribeRepos } = start()
		const client = dial(port, 'feed.example.com', '?cursor=5')
		await client.opened

		put(ALICE, 'feed', '_redirects', '/old /new 301\n')
		deployLog(ALICE, 'feed', 100, 2, [3, 4, 5, 100])
		subscribeRepos.siteUpdated(ALICE, 'feed')
		await Bun.sleep(50)
		expect(client.frames).toEqual([])
		expect((await handshake(port, 'feed.example.com', '?cursor=5')).status).toBe(404)

		put(ALICE, 'feed', '_redirects', OPT_IN)
		subscribeRepos.siteUpdated(ALICE, 'feed')
		await eventually(() => client.frames.length > 0)
		expect(client.frames).toEqual([frame(100)])
	})

	test('a slow reload that lands last cannot take the site back to an older log', async () => {
		let stall: Promise<void> | undefined
		let stalled = false
		const { port, subscribeRepos } = start({
			serveFile: async (did, rkey, path) => {
				const response = await serveFile(did, rkey, path)
				if (stall && path.endsWith('head.json')) {
					const wait = stall
					stall = undefined
					stalled = true
					await wait
				}
				return response
			},
		})
		const first = dial(port, 'feed.example.com', '?cursor=5', '192.0.2.1')
		await first.opened
		await Bun.sleep(50)

		let release = () => {}
		stall = new Promise((resolve) => {
			release = resolve
		})
		subscribeRepos.siteUpdated(ALICE, 'feed')
		await eventually(() => stalled)
		deployLog(ALICE, 'feed', 100, 2, [3, 4, 5, 100])
		subscribeRepos.siteUpdated(ALICE, 'feed')
		await eventually(() => first.frames.length > 0)
		release()
		await Bun.sleep(50)

		const second = dial(port, 'feed.example.com', '?cursor=5', '192.0.2.2')
		await eventually(() => second.frames.length > 0)
		expect([first.frames, second.frames]).toEqual([[frame(100)], [frame(100)]])
	})

	test('a plain GET is told to upgrade, and the answer is never cached', async () => {
		const { port } = start()

		const response = await fetch(`http://127.0.0.1:${port}${PATH}?cursor=0`, { headers: { host: 'feed.example.com' } })

		expect(response.status).toBe(426)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(fromCache).toEqual([])
	})

	test.each(['x', '-1', '', '1.5', '9007199254740992'])('cursor=%p is refused before the upgrade', async (cursor) => {
		const { port } = start()

		expect((await handshake(port, 'feed.example.com', `?cursor=${cursor}`)).status).toBe(400)
	})

	test('dials over the per-client or per-instance cap are refused before the upgrade', async () => {
		const { port } = start({ maxSockets: 2, maxSocketsPerClientPerSite: 1 })

		await dial(port, 'feed.example.com', '', '192.0.2.1').opened
		expect((await handshake(port, 'feed.example.com', '', '192.0.2.1')).status).toBe(503)
		await dial(port, 'feed.example.com', '', '192.0.2.2').opened
		expect((await handshake(port, 'feed.example.com', '', '192.0.2.3')).status).toBe(503)
	})

	test('a frame missing from storage is retried until it arrives, and nothing after it is skipped', async () => {
		const missing = files.get(`${ALICE}/feed/xrpc/_sdp/events/4.cbor`) as Uint8Array<ArrayBuffer>
		files.delete(`${ALICE}/feed/xrpc/_sdp/events/4.cbor`)
		const { port } = start()

		const client = dial(port, 'feed.example.com', '?cursor=2')
		await eventually(() => client.frames.length >= 1)
		await Bun.sleep(50)
		expect(client.frames).toEqual([frame(3)])

		put(ALICE, 'feed', 'xrpc/_sdp/events/4.cbor', missing)
		await eventually(() => client.frames.length >= 3)
		expect(client.frames).toEqual([frame(3), frame(4), frame(5)])
	})

	test('closeAll closes sockets as going away (1001) and refuses new dials', async () => {
		const { port, subscribeRepos } = start()

		const closed = await closeCodeOnTheWire(port, 'feed.example.com', () => subscribeRepos.closeAll())

		expect(closed).toEqual({ status: 'HTTP/1.1 101', code: 1001 })
		expect((await handshake(port, 'feed.example.com')).status).toBe(503)
	})
})

describe('subscribeRepos falls through to the site as served today', () => {
	test.each([
		['without the opt-in line, a self-hosted bridge redirect included', 'bridged.example.com', `${ALICE}/bridged`, 302],
		['for a site owner who is not a supporter', 'bob.example.com', `${BOB}/feed`, 404],
		['without a head.json', 'nolog.example.com', `${ALICE}/nolog`, 404],
		['on a wisp subdomain, even with the opt-in line', 'feed.wisp.place', `${ALICE}/feed`, 404],
	])('%s', async (_, host, site, status) => {
		put(ALICE, 'bridged', '_redirects', `${PATH}  ${BRIDGE}  302\n`)
		deployLog(ALICE, 'bridged', 5, 2, [3, 4, 5])
		put(BOB, 'feed', '_redirects', OPT_IN)
		deployLog(BOB, 'feed', 5, 2, [3, 4, 5])
		put(ALICE, 'nolog', '_redirects', OPT_IN)
		put(ALICE, 'feed', '_redirects', OPT_IN)
		deployLog(ALICE, 'feed', 5, 2, [3, 4, 5])
		const { port } = start()

		const response = await handshake(port, host, '?cursor=0')

		expect(response.status).toBe(status)
		if (status === 302) expect(response.headers.get('location')).toBe(BRIDGE)
		expect(fromCache).toEqual([`${site}${PATH}`])
	})
})

describe('parseEventLog', () => {
	const valid = index(5, 2, [3, 4, 5])
	const tooMany = Array.from({ length: 1001 }, (_, i) => i + 3)

	test("accepts at-sdp's 16-digit microsecond seqs", () => {
		const seq = 1_761_900_000_000_000
		const log = parseEventLog(JSON.stringify(index(seq + 1, seq - 1, [seq, seq + 1])))
		expect(log).toEqual({ head: seq + 1, replayableFrom: seq - 1, seqs: [seq, seq + 1] })
	})

	test.each([
		['text that is not JSON', '{'],
		['another version', { ...valid, version: 2 }],
		['a head that is not a safe integer', { ...valid, head: 2 ** 53 }],
		['a replayable_from that is not an integer', { ...valid, replayable_from: '2' }],
		['replayable_from after head', { ...valid, replayable_from: 6 }],
		['more than 1000 events', index(2000, 2, tooMany)],
		['a seq that is not an integer', { ...valid, events: [entry(3.5)] }],
		['seqs out of order', { ...valid, events: [entry(4), entry(3)] }],
		['a seq at replayable_from', { ...valid, events: [entry(2)] }],
		['a seq after head', { ...valid, events: [entry(6)] }],
		['a file other than <seq>.cbor', { ...valid, events: [{ ...entry(3), file: '../../_redirects' }] }],
		['another checkpoint file', { ...valid, checkpoint: '../../index.html' }],
	])('rejects %s', (_, log) => {
		expect(parseEventLog(typeof log === 'string' ? log : JSON.stringify(log))).toBeNull()
	})
})
