import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'
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
