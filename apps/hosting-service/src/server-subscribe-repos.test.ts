import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
	createSubscribeRepos,
	parseEventLog,
	resolveSubscribeReposLimits,
	type SubscribeReposDeps,
} from './lib/subscribe-repos'
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
/** A frame just under the 256 KiB cap, every byte of it its seq. */
const bigFrame = (seq: number) => new Uint8Array(250 * 1024).fill(seq)
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
function deployLog(
	did: string,
	rkey: string,
	head: number,
	replayableFrom: number,
	seqs: number[],
	body: (seq: number) => Uint8Array<ArrayBuffer> = frame,
): void {
	put(did, rkey, 'xrpc/_sdp/events/head.json', JSON.stringify(index(head, replayableFrom, seqs)))
	put(did, rkey, 'xrpc/_sdp/events/checkpoint.cbor', frame('checkpoint'))
	for (const seq of seqs) put(did, rkey, `xrpc/_sdp/events/${seq}.cbor`, body(seq))
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

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2000
	while (!(await check()) && Date.now() < deadline) await Bun.sleep(5)
}

/** The first whole WebSocket frame in `bytes`, as a server sends it: unmasked. */
function nextFrame(bytes: Buffer) {
	const short = (bytes[1] ?? 0) & 0x7f
	const start = short === 127 ? 10 : short === 126 ? 4 : 2
	if (bytes.length < start) return undefined
	const length = short === 127 ? Number(bytes.readBigUInt64BE(2)) : short === 126 ? bytes.readUInt16BE(2) : short
	if (bytes.length < start + length) return undefined
	return { opcode: (bytes[0] ?? 0) & 0x0f, payload: bytes.subarray(start, start + length), end: start + length }
}

/**
 * Dial subscribeRepos on a raw socket, which can stop reading as a stalled relay does, and which sees the
 * close code: Bun 1.3's WebSocket client reports 1001 as 1000.
 */
async function rawDial(port: number | undefined, host: string, query = '', client = '192.0.2.1') {
	let status = ''
	const frames: Array<{ opcode: number; payload: Buffer }> = []
	let unread = Buffer.alloc(0)
	const { promise: closed, resolve: onClose } = Promise.withResolvers<void>()
	const socket = await Bun.connect({
		hostname: '127.0.0.1',
		port: port as number,
		socket: {
			data(_, chunk) {
				unread = Buffer.concat([unread, chunk])
				if (!status) {
					const end = unread.indexOf('\r\n\r\n')
					if (end < 0) return
					status = unread.subarray(0, 12).toString()
					unread = unread.subarray(end + 4)
				}
				for (let next = nextFrame(unread); next; next = nextFrame(unread)) {
					frames.push(next)
					unread = unread.subarray(next.end)
				}
			},
			close() {
				onClose()
			},
		},
	})
	socket.write(
		`GET ${PATH}${query} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
			`X-Forwarded-For: ${client}\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	)
	await eventually(() => status !== '')
	return { status, frames, socket, closed }
}

async function closeCodeOnTheWire(port: number | undefined, host: string, close: () => void) {
	const relay = await rawDial(port, host, '?cursor=5')
	close()
	await eventually(() => relay.frames.length > 0)
	relay.socket.end()
	const [frame] = relay.frames
	return { status: relay.status, code: frame?.opcode === 0x8 ? frame.payload.readUInt16BE(0) : undefined }
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

	test.each([
		['missing from storage', null],
		['over 256 KiB', new Uint8Array(256 * 1024 + 1)],
	])('a frame %s is held back until a good one arrives, and nothing after it is skipped', async (_, broken) => {
		const missing = files.get(`${ALICE}/feed/xrpc/_sdp/events/4.cbor`) as Uint8Array<ArrayBuffer>
		if (broken) put(ALICE, 'feed', 'xrpc/_sdp/events/4.cbor', broken)
		else files.delete(`${ALICE}/feed/xrpc/_sdp/events/4.cbor`)
		const { port } = start()

		const client = dial(port, 'feed.example.com', '?cursor=2')
		await eventually(() => client.frames.length >= 1)
		await Bun.sleep(50)
		expect(client.frames).toEqual([frame(3)])

		put(ALICE, 'feed', 'xrpc/_sdp/events/4.cbor', missing)
		await eventually(() => client.frames.length >= 3)
		expect(client.frames).toEqual([frame(3), frame(4), frame(5)])
	})

	test('a frame still missing after the grace period gives way to the checkpoint, then the next deploy', async () => {
		files.delete(`${ALICE}/feed/xrpc/_sdp/events/4.cbor`)
		const grace = 100
		const { port, subscribeRepos } = start({ missingFrameGraceMs: grace })

		const dialled = Date.now()
		const client = dial(port, 'feed.example.com', '?cursor=2')
		await eventually(() => client.frames.length >= 2)
		expect(Date.now() - dialled).toBeGreaterThanOrEqual(grace)
		expect(client.frames).toEqual([frame(3), frame('checkpoint')])

		deployLog(ALICE, 'feed', 100, 2, [3, 4, 5, 100])
		subscribeRepos.siteUpdated(ALICE, 'feed')
		await eventually(() => client.frames.length >= 3)
		expect(client.frames).toEqual([frame(3), frame('checkpoint'), frame(100)])
	})

	test('a frame missing past the grace period is still waited for while the checkpoint is missing too', async () => {
		files.delete(`${ALICE}/feed/xrpc/_sdp/events/4.cbor`)
		files.delete(`${ALICE}/feed/xrpc/_sdp/events/checkpoint.cbor`)
		const { port } = start({ missingFrameGraceMs: 20 })

		const client = dial(port, 'feed.example.com', '?cursor=2')
		await eventually(() => client.frames.length >= 1)
		await Bun.sleep(100)
		expect(client.frames).toEqual([frame(3)])
	})

	test('closeAll closes sockets as going away (1001) and refuses new dials', async () => {
		const { port, subscribeRepos } = start()

		const closed = await closeCodeOnTheWire(port, 'feed.example.com', () => subscribeRepos.closeAll())

		expect(closed).toEqual({ status: 'HTTP/1.1 101', code: 1001 })
		expect((await handshake(port, 'feed.example.com')).status).toBe(503)
	})

	/** A relay that stops reading while about 16 MB of frames are published: more than loopback's socket buffers hold. */
	async function stalledRelay(options: Partial<SubscribeReposDeps> = {}) {
		let framesRead = 0
		const { port, subscribeRepos } = start({
			...options,
			serveFile: (did, rkey, path) => {
				if (path.endsWith('.cbor')) framesRead++
				return serveFile(did, rkey, path)
			},
		})
		const relay = await rawDial(port, 'feed.example.com', '?cursor=5')
		relay.socket.pause()
		const seqs = Array.from({ length: 64 }, (_, i) => 6 + i)
		deployLog(ALICE, 'feed', 69, 5, seqs, bigFrame)
		subscribeRepos.siteUpdated(ALICE, 'feed')
		await Bun.sleep(100)
		return { port, relay, seqs, framesRead }
	}

	test('a relay that stops reading holds the stream back, then gets every frame once and in order', async () => {
		const { relay, seqs, framesRead } = await stalledRelay()
		expect(framesRead).toBeWithin(1, seqs.length)

		relay.socket.resume()
		await eventually(() => relay.frames.length >= seqs.length)
		// Summarised, so a failure lists the frames that arrived rather than 16 MB of bytes.
		const summary = (opcode: number, payload: Uint8Array) => ({ opcode, seq: payload[0], bytes: Bun.hash(payload) })
		expect(relay.frames.map(({ opcode, payload }) => summary(opcode, payload))).toEqual(
			seqs.map((seq) => summary(0x2, bigFrame(seq))),
		)
	})

	test('relays at the same point share one read of each new frame', async () => {
		let framesRead = 0
		const { port, subscribeRepos } = start({
			serveFile: (did, rkey, path) => {
				if (path.endsWith('.cbor')) framesRead++
				return serveFile(did, rkey, path)
			},
		})
		const relays = [
			dial(port, 'feed.example.com', '?cursor=5', '192.0.2.1'),
			dial(port, 'feed.example.com', '?cursor=5', '192.0.2.2'),
			dial(port, 'feed.example.com', '?cursor=5', '192.0.2.3'),
		]
		await Promise.all(relays.map((relay) => relay.opened))
		framesRead = 0

		deployLog(ALICE, 'feed', 8, 5, [6, 7, 8])
		subscribeRepos.siteUpdated(ALICE, 'feed')
		await eventually(() => relays.every((relay) => relay.frames.length >= 3))

		for (const relay of relays) expect(relay.frames).toEqual([frame(6), frame(7), frame(8)])
		expect(framesRead).toBe(3)
	})

	test('a stalled relay holding the shared budget is dropped, and the others then get every frame in order', async () => {
		// Room for one queued frame across every socket, which the stalled relay takes.
		const { port, relay, seqs } = await stalledRelay({ maxBufferedBytes: 300 * 1024, slowReaderTimeoutMs: 1000 })
		const reader = await rawDial(port, 'feed.example.com', '?cursor=5', '192.0.2.9')

		// Held back while the stalled relay holds the budget...
		await Bun.sleep(300)
		expect(reader.frames).toHaveLength(0)
		// ...and served in full once it is dropped.
		await eventually(() => reader.frames.length >= seqs.length)
		relay.socket.resume()
		await relay.closed
		expect(relay.frames.filter(({ opcode }) => opcode === 0x2).length).toBeLessThan(seqs.length)
		expect(reader.frames.map(({ opcode, payload }) => [opcode, payload[0]])).toEqual(seqs.map((seq) => [0x2, seq]))
	})

	test('a relay that disconnects while the stream waits on it frees its place for a redial', async () => {
		const { port, relay, seqs, framesRead } = await stalledRelay({ maxSocketsPerClientPerSite: 1 })
		expect(framesRead).toBeWithin(1, seqs.length)

		relay.socket.terminate()
		let accepted = false
		await eventually(async () => {
			accepted = await dial(port, 'feed.example.com', '?cursor=69').opened.then(
				() => true,
				() => false,
			)
			return accepted
		})
		expect(accepted).toBe(true)
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

describe('resolveSubscribeReposLimits', () => {
	test('reads the socket cap and buffer budget from the environment, ignoring bad values', () => {
		expect(
			resolveSubscribeReposLimits({
				SUBSCRIBE_REPOS_MAX_SOCKETS: '100',
				SUBSCRIBE_REPOS_MAX_BUFFERED_BYTES: String(4 << 20),
			}),
		).toEqual({ maxSockets: 100, maxBufferedBytes: 4 << 20 })
		// A budget below one frame could never send anything.
		expect(
			resolveSubscribeReposLimits({ SUBSCRIBE_REPOS_MAX_SOCKETS: '0', SUBSCRIBE_REPOS_MAX_BUFFERED_BYTES: '1024' }),
		).toEqual(resolveSubscribeReposLimits({}))
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
