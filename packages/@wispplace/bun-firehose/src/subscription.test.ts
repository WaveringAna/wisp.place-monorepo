import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { encode } from '@atproto/lex-cbor'
import type { ServerWebSocket } from 'bun'
import { MessageQueue } from './queue'
import { BunSubscription } from './subscription'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

interface Harness {
	connects: number
	disconnects: number
	stop: () => void
}

const cleanups: Array<() => void> = []
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

/** A server that accepts connections and never sends a frame, answering pings like any websocket server. */
function idleServer(): { url: string } {
	const server = Bun.serve({
		port: 0,
		fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no')),
		websocket: { message() {} },
	})
	cleanups.push(() => server.stop(true))
	return { url: `ws://127.0.0.1:${server.port}` }
}

/** Completes the websocket handshake and then ignores everything, so pings go unanswered. */
function deafServer(): Promise<{ url: string }> {
	return new Promise((resolve) => {
		const server: Server = createServer((socket) => {
			socket.once('data', (chunk) => {
				const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(chunk.toString())?.[1]?.trim() ?? ''
				const accept = createHash('sha1')
					.update(key + WS_GUID)
					.digest('base64')
				socket.write(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
				)
				socket.on('data', () => {})
			})
			socket.on('error', () => {})
		})
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as { port: number }
			cleanups.push(() => server.close())
			resolve({ url: `ws://127.0.0.1:${port}` })
		})
	})
}

function run(
	url: string,
	extra: { maxSilenceMs?: number | null; heartbeatIntervalMs?: number; heartbeatTimeoutMs?: number },
): Harness {
	const abort = new AbortController()
	const harness: Harness = { connects: 0, disconnects: 0, stop: () => abort.abort() }
	const subscription = new BunSubscription<unknown>({
		service: url,
		method: 'test.subscribe',
		signal: abort.signal,
		validate: () => undefined,
		maxReconnectSeconds: 1,
		onConnect: () => harness.connects++,
		onDisconnect: () => harness.disconnects++,
		...extra,
	})
	void (async () => {
		for await (const _ of subscription) {
		}
	})()
	cleanups.push(harness.stop)
	return harness
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('BunSubscription silence handling', () => {
	test('reconnects a silent source by default', async () => {
		const { url } = idleServer()
		const harness = run(url, { maxSilenceMs: 100 })

		await sleep(500)

		expect(harness.disconnects).toBeGreaterThanOrEqual(1)
	})

	test('keeps an idle but answering source connected when silence is not a failure', async () => {
		const { url } = idleServer()
		const harness = run(url, { maxSilenceMs: null, heartbeatIntervalMs: 50, heartbeatTimeoutMs: 100 })

		await sleep(800)

		expect(harness.connects).toBe(1)
		expect(harness.disconnects).toBe(0)
	})

	test('reconnects a source that stops answering pings', async () => {
		const { url } = await deafServer()
		const harness = run(url, { maxSilenceMs: null, heartbeatIntervalMs: 50, heartbeatTimeoutMs: 100 })

		await sleep(600)

		expect(harness.disconnects).toBeGreaterThanOrEqual(1)
	})
})

/** A relay replaying `frames` sequence numbers after the requested cursor as fast as the socket takes them. */
function replayServer(frames: number, frameBytes: number): { url: string; cursors: Array<string | null> } {
	const header = encode({ op: 1, t: '#frame' })
	const pad = new Uint8Array(frameBytes)
	const cursors: Array<string | null> = []
	type Stream = { next: number; open: boolean }
	const pump = (ws: ServerWebSocket<Stream>) => {
		while (ws.data.open && ws.data.next <= frames) {
			const body = encode({ seq: ws.data.next++, pad })
			const bytes = new Uint8Array(header.length + body.length)
			bytes.set(header)
			bytes.set(body, header.length)
			if (ws.send(bytes) === -1) return
		}
	}
	const server = Bun.serve<Stream>({
		port: 0,
		fetch(req, srv) {
			const cursor = new URL(req.url).searchParams.get('cursor')
			cursors.push(cursor)
			return srv.upgrade(req, { data: { next: Number(cursor ?? 0) + 1, open: true } })
				? undefined
				: new Response('no', { status: 400 })
		},
		websocket: {
			open: pump,
			drain: pump,
			close(ws) {
				ws.data.open = false
			},
			message() {},
		},
	})
	cleanups.push(() => server.stop(true))
	return { url: `ws://127.0.0.1:${server.port}`, cursors }
}

/** Consumes like a handler awaiting I/O per event, which lets the socket keep delivering meanwhile. */
async function consumeSlowly(
	url: string,
	frames: number,
	options: { maxQueuedBytes: number; committed: boolean },
): Promise<{ seqs: number[]; peakQueued: number; connects: number }> {
	let peakQueued = 0
	const push = MessageQueue.prototype.push
	MessageQueue.prototype.push = function (this: MessageQueue<unknown>, item: unknown) {
		push.call(this, item)
		peakQueued = Math.max(peakQueued, this.length)
	}
	cleanups.push(() => {
		MessageQueue.prototype.push = push
	})

	const seqs: number[] = []
	let connects = 0
	const abort = new AbortController()
	cleanups.push(() => abort.abort())
	const subscription = new BunSubscription<{ seq: number }>({
		service: url,
		method: 'test.subscribe',
		signal: abort.signal,
		maxReconnectSeconds: 1,
		maxQueuedBytes: options.maxQueuedBytes,
		validate: (body) => body as { seq: number },
		getParams: () => (options.committed && seqs.length > 0 ? { cursor: seqs[seqs.length - 1] } : undefined),
		onConnect: () => connects++,
	})
	for await (const { seq } of subscription) {
		seqs.push(seq)
		await new Promise((resolve) => setImmediate(resolve))
		if (seq === frames) break
	}
	return { seqs, peakQueued, connects }
}

describe('BunSubscription backpressure', () => {
	const frames = 5_000
	const frameBytes = 512
	const maxQueuedBytes = 64 * 1024
	const expected = Array.from({ length: frames }, (_, i) => i + 1)

	test('bounds the frame queue and resumes from the committed cursor without losing or reordering', async () => {
		const { url, cursors } = replayServer(frames, frameBytes)

		const result = await consumeSlowly(url, frames, { maxQueuedBytes, committed: true })

		expect(result.seqs).toEqual(expected)
		expect(result.peakQueued).toBeLessThanOrEqual(Math.ceil(maxQueuedBytes / frameBytes))
		expect(result.connects).toBeGreaterThan(1)
		expect(cursors[0]).toBeNull()
		expect(cursors.slice(1).every((cursor) => cursor !== null)).toBe(true)
	}, 30_000)

	test('resumes after the last delivered frame when the consumer has no cursor yet', async () => {
		const { url, cursors } = replayServer(frames, frameBytes)

		const result = await consumeSlowly(url, frames, { maxQueuedBytes, committed: false })

		expect(result.seqs).toEqual(expected)
		expect(result.connects).toBeGreaterThan(1)
		expect(cursors.slice(1).every((cursor) => cursor !== null)).toBe(true)
	}, 30_000)
})
