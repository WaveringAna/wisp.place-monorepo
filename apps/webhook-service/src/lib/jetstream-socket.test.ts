import { afterEach, describe, expect, test } from 'bun:test'
import * as net from 'node:net'
import * as zlib from 'node:zlib'
import { JetstreamSocket, type JetstreamSocketOptions, websocketAccept } from './jetstream-socket'

type ServerSocket = Bun.ServerWebSocket<undefined>

const cleanups: (() => void)[] = []

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

function bunServer(websocket: Partial<Bun.WebSocketHandler<undefined>>): string {
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return undefined
			return new Response('not a websocket', { status: 400 })
		},
		websocket: { message() {}, ...websocket },
	})
	cleanups.push(() => server.stop(true))
	return `ws://127.0.0.1:${server.port}/subscribe?cursor=1`
}

/** A hand-rolled server for behaviour Bun.serve will not produce. */
async function rawServer(onConnection: (socket: net.Socket, head: string) => void): Promise<string> {
	const server = net.createServer((socket) => {
		let buffered = ''
		const onData = (chunk: Buffer) => {
			buffered += chunk.toString('latin1')
			const end = buffered.indexOf('\r\n\r\n')
			if (end === -1) return
			socket.off('data', onData)
			onConnection(socket, buffered.slice(0, end))
		}
		socket.on('data', onData)
		socket.on('error', () => {})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	cleanups.push(() => server.close())
	const address = server.address() as net.AddressInfo
	return `ws://127.0.0.1:${address.port}/`
}

function requestKey(head: string): string {
	return /^sec-websocket-key: *(.+)$/im.exec(head)?.[1]?.trim() ?? ''
}

function upgradeResponse(accept: string): string {
	return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
}

const DEFLATE_ACCEPT = 'permessage-deflate; server_no_context_takeover; client_no_context_takeover'

function deflateResponse(accept: string, extension = DEFLATE_ACCEPT): string {
	return upgradeResponse(accept).replace('\r\n\r\n', `\r\nSec-WebSocket-Extensions: ${extension}\r\n\r\n`)
}

/** One message as permessage-deflate sends it: a sync-flushed raw deflate without its 00 00 ff ff tail. */
function deflated(payload: Buffer): Buffer {
	const out = zlib.deflateRawSync(payload, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
	return out.subarray(0, out.byteLength - 4)
}

function withRsv1(frame: Buffer): Buffer {
	frame[0] = (frame[0] as number) | 0x40
	return frame
}

function serverFrame(opcode: number, payload: Buffer, options: { fin?: boolean; mask?: boolean } = {}): Buffer {
	const length = payload.byteLength
	const header =
		length < 126
			? Buffer.from([0, length])
			: length <= 0xffff
				? Buffer.from([0, 126, length >> 8, length & 0xff])
				: Buffer.concat([Buffer.from([0, 127]), Buffer.alloc(8)])
	if (length > 0xffff) header.writeBigUInt64BE(BigInt(length), 2)
	header[0] = ((options.fin ?? true) ? 0x80 : 0) | opcode
	if (!options.mask) return Buffer.concat([header, payload])
	header[1] = (header[1] as number) | 0x80
	return Buffer.concat([header, Buffer.from([1, 2, 3, 4]), payload.map((byte, index) => byte ^ ((index % 4) + 1))])
}

interface Recorded {
	socket: JetstreamSocket
	events: string[]
	messages: (string | Uint8Array)[]
	opened: Promise<void>
	closed: Promise<void>
}

function connect(url: string, options?: JetstreamSocketOptions): Recorded {
	const socket = new JetstreamSocket(url, options)
	const events: string[] = []
	const messages: (string | Uint8Array)[] = []
	let opened = () => {}
	let closed = () => {}
	const recorded: Recorded = {
		socket,
		events,
		messages,
		opened: new Promise((resolve) => {
			opened = resolve
		}),
		closed: new Promise((resolve) => {
			closed = resolve
		}),
	}
	socket.onopen = () => {
		events.push('open')
		opened()
	}
	socket.onmessage = ({ data }) => {
		messages.push(data)
	}
	socket.onerror = () => events.push('error')
	socket.onclose = () => {
		events.push('close')
		closed()
	}
	cleanups.push(() => socket.close())
	return recorded
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!condition()) {
		if (Date.now() > deadline) throw new Error('condition not reached')
		await Bun.sleep(5)
	}
}

/** Wait past any late callbacks so "exactly once" assertions mean something. */
const settle = () => Bun.sleep(50)

describe('JetstreamSocket', () => {
	test('computes the RFC 6455 sample accept key', () => {
		expect(websocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
	})

	test('opens and receives text', async () => {
		const url = bunServer({
			open: (ws) => {
				ws.send('{"hello":"world"}')
			},
		})
		const client = connect(url)
		await until(() => client.messages.length === 1)
		expect(client.events).toEqual(['open'])
		expect(client.messages).toEqual(['{"hello":"world"}'])
	})

	test('sends the upgrade request the contract specifies', async () => {
		let head = ''
		const url = await rawServer((socket, request) => {
			head = request
			socket.write(upgradeResponse(websocketAccept(requestKey(request))))
		})
		const client = connect(url.replace(/\/$/, '/subscribe?cursor=5'), { userAgent: 'wisp-test/1' })
		await client.opened
		const port = new URL(url).port
		expect(head.split('\r\n')[0]).toBe('GET /subscribe?cursor=5 HTTP/1.1')
		expect(head).toContain(`Host: 127.0.0.1:${port}`)
		expect(head).toContain('Upgrade: websocket')
		expect(head).toContain('Connection: Upgrade')
		expect(head).toContain('Sec-WebSocket-Version: 13')
		expect(head).toContain('User-Agent: wisp-test/1')
		expect(Buffer.from(requestKey(head), 'base64').byteLength).toBe(16)
		expect(head.toLowerCase()).not.toContain('sec-websocket-extensions')
	})

	test('receives binary as Uint8Array', async () => {
		const url = bunServer({
			open: (ws) => {
				ws.send(new Uint8Array([0, 1, 2, 255]))
			},
		})
		const client = connect(url)
		await until(() => client.messages.length === 1)
		const [message] = client.messages
		expect(message).toBeInstanceOf(Uint8Array)
		expect([...(message as Uint8Array)]).toEqual([0, 1, 2, 255])
	})

	test('treats bytes in the handshake chunk as frame data and reassembles fragments around a ping', async () => {
		let pong: Buffer | undefined
		const url = await rawServer((socket, request) => {
			socket.on('data', (chunk: Buffer) => {
				pong = chunk
			})
			socket.write(
				Buffer.concat([
					Buffer.from(upgradeResponse(websocketAccept(requestKey(request)))),
					serverFrame(0x1, Buffer.from('frag'), { fin: false }),
					serverFrame(0x9, Buffer.from('mid')),
					serverFrame(0x0, Buffer.from('men'), { fin: false }),
					serverFrame(0x0, Buffer.from('ted ✓')),
				]),
			)
		})
		const client = connect(url)
		await until(() => client.messages.length === 1 && pong !== undefined)
		expect(client.messages).toEqual(['fragmented ✓'])
		// Client pong: FIN+opcode 10, masked, length 3.
		expect(pong?.[0]).toBe(0x8a)
		expect(pong?.[1]).toBe(0x80 | 3)
	})

	test('parses frames split at every byte boundary', async () => {
		const payload = 'x'.repeat(300)
		const url = await rawServer(async (socket, request) => {
			socket.setNoDelay(true)
			socket.write(upgradeResponse(websocketAccept(requestKey(request))))
			const bytes = Buffer.concat([serverFrame(0x1, Buffer.from('a')), serverFrame(0x1, Buffer.from(payload))])
			for (const byte of bytes) {
				socket.write(Buffer.from([byte]))
				await Bun.sleep(0)
			}
		})
		const client = connect(url)
		await until(() => client.messages.length === 2)
		expect(client.messages).toEqual(['a', payload])
	})

	test('handles 16-bit and 64-bit payload lengths', async () => {
		const medium = 'm'.repeat(200)
		const large = 'L'.repeat(70_000)
		const url = bunServer({
			open: (ws) => {
				ws.send(medium)
				ws.send(large)
			},
		})
		const client = connect(url)
		await until(() => client.messages.length === 2)
		expect(client.messages[0]).toBe(medium)
		expect(client.messages[1]).toBe(large)
	})

	test('answers a server ping with a pong carrying the same payload', async () => {
		let received: string | undefined
		const url = bunServer({
			open: (ws) => {
				ws.ping('are-you-there')
			},
			pong: (_ws, data) => {
				received = data.toString()
			},
		})
		connect(url)
		await until(() => received !== undefined)
		expect(received).toBe('are-you-there')
	})

	test('closes once when the server closes', async () => {
		const url = bunServer({ open: (ws) => ws.close(1001, 'going away') })
		const client = connect(url)
		await client.closed
		await settle()
		expect(client.events).toEqual(['open', 'close'])
	})

	test('closes once when the server drops TCP without a close frame', async () => {
		const url = await rawServer((socket, request) => {
			socket.write(upgradeResponse(websocketAccept(requestKey(request))))
			setTimeout(() => socket.destroy(), 20)
		})
		const client = connect(url)
		await client.closed
		await settle()
		expect(client.events.filter((event) => event === 'close')).toHaveLength(1)
		expect(client.events[0]).toBe('open')
	})

	test('client close sends code 1000 and fires onclose once, with no later messages', async () => {
		let code: number | undefined
		let server: ServerSocket | undefined
		const url = bunServer({
			open: (ws) => {
				server = ws
			},
			close: (_ws, closeCode) => {
				code = closeCode
			},
		})
		const client = connect(url)
		await client.opened
		await until(() => server !== undefined)
		client.socket.close()
		client.socket.close()
		server?.send('too late')
		await client.closed
		await until(() => code !== undefined)
		await settle()
		expect(code).toBe(1000)
		expect(client.messages).toEqual([])
		expect(client.events).toEqual(['open', 'close'])
	})

	test('close while connecting never opens', async () => {
		const url = bunServer({})
		const client = connect(url)
		client.socket.close()
		await client.closed
		await settle()
		expect(client.events).toEqual(['close'])
	})

	test('pause holds delivery while the server keeps sending; resume delivers everything in order', async () => {
		const total = 2_000
		let sent = 0
		const url = bunServer({
			open: (ws) => {
				const timer = setInterval(() => {
					for (let batch = 0; batch < 100 && sent < total; batch++) ws.send(String(sent++))
					if (sent >= total) clearInterval(timer)
				}, 5)
			},
		})
		const client = connect(url)
		await until(() => client.messages.length > 0)
		client.socket.pause()
		const atPause = client.messages.length
		await until(() => sent >= total)
		await Bun.sleep(100)
		expect(client.messages.length).toBe(atPause)
		client.socket.resume()
		await until(() => client.messages.length === total)
		expect(client.messages).toEqual(Array.from({ length: total }, (_, index) => String(index)))
	})

	test('pause stops reading TCP, so the server sees backpressure', async () => {
		let server: ServerSocket | undefined
		const url = bunServer({
			open: (ws) => {
				server = ws
			},
		})
		const client = connect(url)
		await client.opened
		await until(() => server !== undefined)
		client.socket.pause()
		const chunk = 'p'.repeat(64 * 1024)
		for (let index = 0; index < 256; index++) server?.send(chunk)
		await Bun.sleep(100)
		expect(client.messages).toEqual([])
		expect(server?.getBufferedAmount()).toBeGreaterThan(0)
		client.socket.resume()
		await until(() => client.messages.length === 256, 5_000)
	})

	test('pause from inside onmessage holds already-buffered complete frames', async () => {
		const url = await rawServer((socket, request) => {
			socket.write(
				Buffer.concat([
					Buffer.from(upgradeResponse(websocketAccept(requestKey(request)))),
					...['1', '2', '3'].map((text) => serverFrame(0x1, Buffer.from(text))),
				]),
			)
		})
		const socket = new JetstreamSocket(url)
		cleanups.push(() => socket.close())
		const messages: unknown[] = []
		socket.onmessage = ({ data }) => {
			messages.push(data)
			if (messages.length === 1) socket.pause()
		}
		await until(() => messages.length === 1)
		await Bun.sleep(50)
		expect(messages).toEqual(['1'])
		socket.resume()
		await until(() => messages.length === 3)
		expect(messages).toEqual(['1', '2', '3'])
	})

	test('a throwing onmessage does not break parsing', async () => {
		const url = bunServer({
			open: (ws) => {
				ws.send('a')
				ws.send('b')
			},
		})
		const socket = new JetstreamSocket(url)
		cleanups.push(() => socket.close())
		const messages: unknown[] = []
		socket.onmessage = ({ data }) => {
			messages.push(data)
			throw new Error('consumer bug')
		}
		await until(() => messages.length === 2)
		expect(messages).toEqual(['a', 'b'])
	})

	test('rejects a wrong Sec-WebSocket-Accept', async () => {
		const url = await rawServer((socket) => socket.write(upgradeResponse(websocketAccept('not the key'))))
		const client = connect(url)
		await client.closed
		await settle()
		expect(client.events).toEqual(['error', 'close'])
	})

	test('rejects a non-101 status', async () => {
		const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('nope', { status: 200 }) })
		cleanups.push(() => server.stop(true))
		const client = connect(`ws://127.0.0.1:${server.port}/`)
		await client.closed
		await settle()
		expect(client.events).toEqual(['error', 'close'])
	})

	test('rejects an oversized handshake response', async () => {
		const url = await rawServer((socket) => {
			socket.write(`HTTP/1.1 101 Switching Protocols\r\nX-Padding: ${'a'.repeat(20_000)}\r\n`)
		})
		const client = connect(url)
		await client.closed
		await settle()
		expect(client.events).toEqual(['error', 'close'])
	})

	test('a message over maxMessageBytes is a protocol error', async () => {
		const url = bunServer({
			open: (ws) => {
				ws.send('x'.repeat(2_000))
			},
		})
		const client = connect(url, { maxMessageBytes: 1_000 })
		await client.closed
		await settle()
		expect(client.messages).toEqual([])
		expect(client.events).toEqual(['open', 'error', 'close'])
	})

	test('maxMessageBytes counts every fragment of a message', async () => {
		const url = await rawServer((socket, request) => {
			socket.write(
				Buffer.concat([
					Buffer.from(upgradeResponse(websocketAccept(requestKey(request)))),
					serverFrame(0x1, Buffer.alloc(600, 0x61), { fin: false }),
					serverFrame(0x0, Buffer.alloc(600, 0x61)),
				]),
			)
		})
		const client = connect(url, { maxMessageBytes: 1_000 })
		await client.closed
		await settle()
		expect(client.messages).toEqual([])
		expect(client.events).toEqual(['open', 'error', 'close'])
	})

	test('inflates permessage-deflate messages, whole and fragmented', async () => {
		const whole = deflated(Buffer.from('{"kind":"commit"}'))
		const split = deflated(Buffer.from('fragmented and deflated'))
		const url = await rawServer((socket, request) => {
			socket.write(
				Buffer.concat([
					Buffer.from(deflateResponse(websocketAccept(requestKey(request)))),
					withRsv1(serverFrame(0x1, whole)),
					withRsv1(serverFrame(0x1, split.subarray(0, 5), { fin: false })),
					serverFrame(0x0, split.subarray(5)),
					serverFrame(0x1, Buffer.from('plain')),
				]),
			)
		})
		const client = connect(url, { compress: true })
		await until(() => client.messages.length === 3)
		expect(client.messages).toEqual(['{"kind":"commit"}', 'fragmented and deflated', 'plain'])
		client.socket.close()
	})

	test('refuses a deflate answer that keeps context takeover', async () => {
		const url = await rawServer((socket, request) => {
			socket.write(deflateResponse(websocketAccept(requestKey(request)), 'permessage-deflate'))
		})
		const client = connect(url, { compress: true })
		await client.closed
		await settle()
		expect(client.events).toEqual(['error', 'close'])
	})

	test('a message that inflates past maxMessageBytes is a protocol error', async () => {
		const bomb = deflated(Buffer.alloc(64 * 1024))
		const url = await rawServer((socket, request) => {
			socket.write(
				Buffer.concat([
					Buffer.from(deflateResponse(websocketAccept(requestKey(request)))),
					withRsv1(serverFrame(0x1, bomb)),
				]),
			)
		})
		const client = connect(url, { maxMessageBytes: 1024, compress: true })
		await client.closed
		await settle()
		expect(bomb.byteLength).toBeLessThan(1024)
		expect(client.messages).toEqual([])
		expect(client.events).toEqual(['open', 'error', 'close'])
	})

	test('RSV1 on a continuation frame is a protocol error', async () => {
		const url = await rawServer((socket, request) => {
			socket.write(
				Buffer.concat([
					Buffer.from(deflateResponse(websocketAccept(requestKey(request)))),
					serverFrame(0x1, Buffer.from('a'), { fin: false }),
					withRsv1(serverFrame(0x0, Buffer.from('b'))),
				]),
			)
		})
		const client = connect(url, { compress: true })
		await client.closed
		await settle()
		expect(client.messages).toEqual([])
		expect(client.events).toEqual(['open', 'error', 'close'])
	})

	test('offers deflate only when asked, and refuses an extension it did not offer', async () => {
		let offered = ''
		const url = await rawServer((socket, request) => {
			offered = request
			socket.write(deflateResponse(websocketAccept(requestKey(request))))
		})
		const plain = connect(url)
		await plain.closed
		await settle()
		expect(offered.toLowerCase()).not.toContain('sec-websocket-extensions')
		expect(plain.events).toEqual(['error', 'close'])
		const deflate = connect(url, { compress: true })
		await deflate.opened
		expect(offered.toLowerCase()).toContain(`sec-websocket-extensions: ${DEFLATE_ACCEPT}`)
		deflate.socket.close()
	})

	test('a masked server frame is a protocol error', async () => {
		const url = await rawServer((socket, request) => {
			socket.write(
				Buffer.concat([
					Buffer.from(upgradeResponse(websocketAccept(requestKey(request)))),
					serverFrame(0x1, Buffer.from('hidden'), { mask: true }),
				]),
			)
		})
		const client = connect(url)
		await client.closed
		await settle()
		expect(client.messages).toEqual([])
		expect(client.events).toEqual(['open', 'error', 'close'])
	})

	test('reserved bits and opcodes are protocol errors', async () => {
		for (const first of [0x80 | 0x40 | 0x1, 0x80 | 0x3, 0x80 | 0xb]) {
			const url = await rawServer((socket, request) => {
				const frame = serverFrame(0x1, Buffer.from('x'))
				frame[0] = first
				socket.write(Buffer.concat([Buffer.from(upgradeResponse(websocketAccept(requestKey(request)))), frame]))
			})
			const client = connect(url)
			await client.closed
			expect(client.messages).toEqual([])
			expect(client.events).toEqual(['open', 'error', 'close'])
		}
	})

	test('times out a connection that never upgrades', async () => {
		const url = await rawServer(() => {})
		const started = Date.now()
		const client = connect(url, { connectTimeoutMs: 100 })
		await client.closed
		await settle()
		expect(Date.now() - started).toBeGreaterThanOrEqual(90)
		expect(client.events).toEqual(['error', 'close'])
	})

	test('a refused connection errors then closes', async () => {
		const url = await rawServer(() => {})
		for (const cleanup of cleanups.splice(0)) cleanup()
		await Bun.sleep(20)
		const client = connect(url)
		await client.closed
		await settle()
		expect(client.events).toEqual(['error', 'close'])
	})
})
