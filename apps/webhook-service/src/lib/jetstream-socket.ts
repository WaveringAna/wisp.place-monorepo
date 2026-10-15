import { createHash, randomBytes } from 'node:crypto'
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as zlib from 'node:zlib'

/**
 * The transport surface JetstreamClient needs. Bun's WebSocket cannot stop
 * reading, so a slow consumer can only close it; this one can pause.
 */
export interface JetstreamSocketLike {
	onopen: (() => void) | null
	onmessage: ((message: { data: string | Uint8Array }) => void) | null
	onerror: (() => void) | null
	onclose: (() => void) | null
	close(): void
	/** Stop reading the TCP socket and deliver no further messages (not even already-buffered complete frames) until resume(). */
	pause(): void
	resume(): void
}

export interface JetstreamSocketOptions {
	/** A whole message (all fragments) larger than this is a protocol error: onerror, then close. */
	maxMessageBytes?: number
	/** Covers TCP, TLS and the HTTP upgrade. */
	connectTimeoutMs?: number
	userAgent?: string
	/**
	 * Offer permessage-deflate. It saves bandwidth, but Jetstream sends deflated
	 * frames slower (~34k/s per connection, against 41-60k/s plain) and inflating
	 * costs our CPU, so only bandwidth-bound hosts gain.
	 */
	compress?: boolean
}

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_HANDSHAKE_BYTES = 16 * 1024
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
// Without a caller limit a hostile length field could still ask us to buffer
// gigabytes; Jetstream events are a few KiB.
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
// A peer that never answers our close frame must not hold the socket open.
const CLOSE_GRACE_MS = 2_000
const HEADER_END = Buffer.from('\r\n\r\n')

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

const CLOSE_NORMAL = Buffer.from([0x03, 0xe8])

// Each message deflated on its own, so one stateless inflate per message is
// exact; context takeover would tie every message to its predecessors.
const DEFLATE_OFFER = 'permessage-deflate; server_no_context_takeover; client_no_context_takeover'
const DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff])
const RSV1 = 0x40

/** The one extension we accept: permessage-deflate that keeps server_no_context_takeover. */
function acceptableDeflate(value: string): boolean {
	const [name, ...parameters] = value.split(';').map((part) => part.trim().toLowerCase())
	if (name !== 'permessage-deflate' || value.includes(',')) return false
	if (!parameters.includes('server_no_context_takeover')) return false
	return parameters.every((parameter) =>
		/^(server_no_context_takeover|client_no_context_takeover|(server|client)_max_window_bits(=(8|9|1[0-5]))?)$/.test(
			parameter,
		),
	)
}

export function negotiatesDeflate(head: string): boolean {
	return /\r\nsec-websocket-extensions:/i.test(head)
}

export function websocketAccept(key: string): string {
	return createHash('sha1')
		.update(key + WEBSOCKET_GUID)
		.digest('base64')
}

export function upgradeRequest(url: URL, key: string, userAgent?: string, compress = false): string {
	const secure = url.protocol === 'wss:'
	const defaultPort = secure ? '443' : '80'
	const host = url.port && url.port !== defaultPort ? `${url.hostname}:${url.port}` : url.hostname
	const lines = [
		`GET ${url.pathname || '/'}${url.search} HTTP/1.1`,
		`Host: ${host}`,
		'Upgrade: websocket',
		'Connection: Upgrade',
		`Sec-WebSocket-Key: ${key}`,
		'Sec-WebSocket-Version: 13',
		...(compress ? [`Sec-WebSocket-Extensions: ${DEFLATE_OFFER}`] : []),
		...(userAgent ? [`User-Agent: ${userAgent}`] : []),
	]
	return `${lines.join('\r\n')}\r\n\r\n`
}

/** Returns why an upgrade response is unacceptable, or null when it completes the handshake. */
export function upgradeResponseError(head: string, key: string, deflateOffered = false): string | null {
	const [statusLine = '', ...headerLines] = head.split('\r\n')
	if (!/^HTTP\/1\.1 101(?: |$)/.test(statusLine)) return 'unexpected upgrade status'
	const headers = new Map<string, string>()
	for (const line of headerLines) {
		const colon = line.indexOf(':')
		if (colon <= 0) return 'malformed upgrade header'
		const name = line.slice(0, colon).trim().toLowerCase()
		const value = line.slice(colon + 1).trim()
		headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value)
	}
	const tokens = (name: string) =>
		(headers.get(name) ?? '')
			.toLowerCase()
			.split(',')
			.map((token) => token.trim())
	if (!tokens('upgrade').includes('websocket')) return 'missing websocket upgrade'
	if (!tokens('connection').includes('upgrade')) return 'missing connection upgrade'
	if (headers.get('sec-websocket-accept') !== websocketAccept(key)) return 'invalid websocket accept'
	const extensions = headers.get('sec-websocket-extensions')
	if (extensions !== undefined && !(deflateOffered && acceptableDeflate(extensions)))
		return 'unsupported websocket extension'
	// We offered no subprotocol, so a server that picks one speaks a protocol we cannot parse.
	if (headers.has('sec-websocket-protocol')) return 'unrequested websocket subprotocol'
	return null
}

/** A masked client frame. Payloads here are control frames, so they are small. */
export function encodeClientFrame(opcode: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
	const length = payload.byteLength
	const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8
	const frame = Buffer.allocUnsafe(2 + lengthBytes + 4 + length)
	frame[0] = 0x80 | opcode
	if (lengthBytes === 0) frame[1] = 0x80 | length
	else if (lengthBytes === 2) {
		frame[1] = 0x80 | 126
		frame.writeUInt16BE(length, 2)
	} else {
		frame[1] = 0x80 | 127
		frame.writeBigUInt64BE(BigInt(length), 2)
	}
	const maskOffset = 2 + lengthBytes
	randomBytes(4).copy(frame, maskOffset)
	const payloadOffset = maskOffset + 4
	for (let index = 0; index < length; index++) {
		frame[payloadOffset + index] = (payload[index] as number) ^ (frame[maskOffset + (index & 3)] as number)
	}
	return frame
}

/**
 * Received bytes as a list of chunks. Frames that sit inside one chunk (nearly
 * all of them) are zero-copy views; only frames spanning chunks are copied,
 * once, so buffering never costs more than linear time.
 */
class ByteQueue {
	private chunks: Buffer[] = []
	private offset = 0
	length = 0

	push(chunk: Buffer): void {
		if (chunk.byteLength === 0) return
		this.chunks.push(chunk)
		this.length += chunk.byteLength
	}

	clear(): void {
		this.chunks = []
		this.offset = 0
		this.length = 0
	}

	/** Caller guarantees index < length. */
	byteAt(index: number): number {
		let position = index + this.offset
		for (const chunk of this.chunks) {
			if (position < chunk.byteLength) return chunk[position] as number
			position -= chunk.byteLength
		}
		return 0
	}

	/** Remove and return the next count bytes. Caller guarantees count <= length. */
	take(count: number): Buffer {
		const first = this.chunks[0]
		if (!first || count === 0) return Buffer.alloc(0)
		if (this.offset + count <= first.byteLength) {
			const view = first.subarray(this.offset, this.offset + count)
			this.skip(count)
			return view
		}
		const result = Buffer.allocUnsafe(count)
		let written = 0
		while (written < count) {
			const chunk = this.chunks[0] as Buffer
			const copied = chunk.copy(result, written, this.offset, Math.min(chunk.byteLength, this.offset + count - written))
			written += copied
			this.skip(copied)
		}
		return result
	}

	skip(count: number): void {
		this.length -= count
		let remaining = count
		while (remaining > 0) {
			const chunk = this.chunks[0] as Buffer
			const available = chunk.byteLength - this.offset
			if (remaining < available) {
				this.offset += remaining
				return
			}
			remaining -= available
			this.chunks.shift()
			this.offset = 0
		}
	}
}

type State = 'connecting' | 'open' | 'closing' | 'closed'

/**
 * A minimal RFC 6455 client over node:net/node:tls whose pause() really stops
 * reading the TCP socket, so a slow consumer pushes back on the relay through
 * TCP flow control instead of closing and replaying.
 */
export class JetstreamSocket implements JetstreamSocketLike {
	onopen: (() => void) | null = null
	onmessage: ((message: { data: string | Uint8Array }) => void) | null = null
	onerror: (() => void) | null = null
	onclose: (() => void) | null = null

	private state: State = 'connecting'
	private readonly socket: net.Socket
	private readonly key = randomBytes(16).toString('base64')
	private readonly maxMessageBytes: number
	private readonly deflateOffered: boolean
	private handshake: Buffer | null = Buffer.alloc(0)
	private readonly received = new ByteQueue()
	private fragments: Buffer[] = []
	private fragmentBytes = 0
	private fragmentOpcode = -1
	private fragmentCompressed = false
	/** The peer agreed to deflate each message independently. */
	private deflate = false
	private paused = false
	private delivering = false
	private deliveryScheduled = false
	private userClosed = false
	private closeSent = false
	private errored = false
	private timer: ReturnType<typeof setTimeout> | null = null

	constructor(url: string, options: JetstreamSocketOptions = {}) {
		const target = new URL(url)
		if (target.protocol !== 'wss:' && target.protocol !== 'ws:')
			throw new SyntaxError('JetstreamSocket needs a ws: or wss: URL')
		this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
		this.deflateOffered = options.compress === true
		const secure = target.protocol === 'wss:'
		const host = target.hostname.replace(/^\[(.*)\]$/, '$1')
		const port = Number(target.port || (secure ? 443 : 80))
		const request = upgradeRequest(target, this.key, options.userAgent, options.compress)
		const sendRequest = () => {
			if (this.state === 'connecting') this.socket.write(request)
		}
		this.socket = secure
			? tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }) }, sendRequest)
			: net.connect({ host, port }, sendRequest)
		this.socket.setNoDelay(true)
		this.socket.on('data', (chunk: Buffer) => this.receive(chunk))
		this.socket.on('error', () => this.fail())
		this.socket.on('close', () => this.finish())
		this.timer = setTimeout(() => this.fail(), options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
	}

	close(): void {
		if (this.userClosed || this.state === 'closed') return
		this.userClosed = true
		if (this.state === 'connecting') {
			this.teardown()
			return
		}
		this.received.clear()
		this.sendClose(CLOSE_NORMAL)
	}

	pause(): void {
		if (this.paused) return
		this.paused = true
		if (this.state === 'open') this.socket.pause()
	}

	resume(): void {
		if (!this.paused) return
		this.paused = false
		if (this.state === 'closed') return
		this.socket.resume()
		// Delivering from inside resume() would re-enter whichever callback called it.
		if (!this.deliveryScheduled) {
			this.deliveryScheduled = true
			queueMicrotask(() => {
				this.deliveryScheduled = false
				this.deliver()
			})
		}
	}

	private receive(chunk: Buffer): void {
		if (this.userClosed) return
		if (this.state === 'open') {
			this.received.push(chunk)
			this.deliver()
		} else if (this.state === 'connecting') this.receiveHandshake(chunk)
		// While closing we only wait for the peer's EOF; late frames are moot.
	}

	private receiveHandshake(chunk: Buffer): void {
		const buffered = Buffer.concat([this.handshake ?? Buffer.alloc(0), chunk])
		const end = buffered.indexOf(HEADER_END)
		if (end === -1) {
			if (buffered.byteLength > MAX_HANDSHAKE_BYTES) this.fail()
			else this.handshake = buffered
			return
		}
		if (end + HEADER_END.byteLength > MAX_HANDSHAKE_BYTES) {
			this.fail()
			return
		}
		const head = buffered.toString('latin1', 0, end)
		if (upgradeResponseError(head, this.key, this.deflateOffered) !== null) {
			this.fail()
			return
		}
		this.deflate = negotiatesDeflate(head)
		this.handshake = null
		this.clearTimer()
		this.state = 'open'
		this.received.push(buffered.subarray(end + HEADER_END.byteLength))
		if (this.paused) this.socket.pause()
		if (!this.userClosed) this.emit(this.onopen)
		this.deliver()
	}

	/** Parse and dispatch every complete frame, stopping at pause, close or a partial frame. */
	private deliver(): void {
		if (this.delivering) return
		this.delivering = true
		try {
			while (this.state === 'open' && !this.paused && !this.userClosed && this.readFrame()) {}
		} finally {
			this.delivering = false
		}
	}

	/** Consume one frame if it is complete. Returns false when more bytes are needed or the stream ended. */
	private readFrame(): boolean {
		const queue = this.received
		if (queue.length < 2) return false
		const first = queue.byteAt(0)
		const second = queue.byteAt(1)
		const fin = (first & 0x80) !== 0
		const opcode = first & 0x0f
		const control = (opcode & 0x08) !== 0
		// RSV1 marks a deflated message, and only on its first data frame.
		const compressed = (first & RSV1) !== 0
		if (compressed && (!this.deflate || control || opcode === OP_CONTINUATION)) return this.protocolError()
		if ((first & 0x30) !== 0 || (second & 0x80) !== 0) return this.protocolError()
		if (control ? opcode > OP_PONG : opcode > OP_BINARY) return this.protocolError()

		let length = second & 0x7f
		let headerBytes = 2
		if (length === 126) {
			if (queue.length < 4) return false
			length = (queue.byteAt(2) << 8) | queue.byteAt(3)
			headerBytes = 4
		} else if (length === 127) {
			if (queue.length < 10) return false
			const high = queue.byteAt(2) * 0x1000000 + (queue.byteAt(3) << 16) + (queue.byteAt(4) << 8) + queue.byteAt(5)
			const low = queue.byteAt(6) * 0x1000000 + (queue.byteAt(7) << 16) + (queue.byteAt(8) << 8) + queue.byteAt(9)
			// Anything past 2^53 is beyond every sane message limit anyway.
			if (high >= 0x200000) return this.protocolError()
			length = high * 0x100000000 + low
			headerBytes = 10
		}
		if (control && (!fin || length > 125)) return this.protocolError()
		// Reject oversized messages from the header alone, before buffering their payload.
		if (!control && (opcode === OP_CONTINUATION ? this.fragmentBytes : 0) + length > this.maxMessageBytes)
			return this.protocolError()
		if (queue.length < headerBytes + length) return false
		queue.skip(headerBytes)
		const payload = queue.take(length)

		if (control) return this.control(opcode, payload)
		if (opcode === OP_CONTINUATION) {
			if (this.fragmentOpcode === -1) return this.protocolError()
			this.fragments.push(payload)
			this.fragmentBytes += length
			if (!fin) return true
			const message = Buffer.concat(this.fragments, this.fragmentBytes)
			const messageOpcode = this.fragmentOpcode
			const messageCompressed = this.fragmentCompressed
			this.fragments = []
			this.fragmentBytes = 0
			this.fragmentOpcode = -1
			this.fragmentCompressed = false
			return this.dispatch(messageOpcode, message, messageCompressed)
		}
		if (this.fragmentOpcode !== -1) return this.protocolError()
		if (!fin) {
			this.fragmentOpcode = opcode
			this.fragmentCompressed = compressed
			this.fragments = [payload]
			this.fragmentBytes = length
			return true
		}
		return this.dispatch(opcode, payload, compressed)
	}

	private control(opcode: number, payload: Buffer): boolean {
		if (opcode === OP_PING) this.write(encodeClientFrame(OP_PONG, payload))
		else if (opcode === OP_CLOSE) {
			// Echo the peer's status code, as RFC 6455 5.5.1 suggests.
			this.sendClose(payload.subarray(0, 2))
			return false
		}
		return true
	}

	/** Returns false when the message could not be decoded, which ends the stream. */
	private dispatch(opcode: number, payload: Buffer, compressed: boolean): boolean {
		let message = payload
		if (compressed) {
			try {
				message = zlib.inflateRawSync(Buffer.concat([payload, DEFLATE_TAIL]), {
					finishFlush: zlib.constants.Z_SYNC_FLUSH,
					maxOutputLength: this.maxMessageBytes,
				})
			} catch {
				// Corrupt or larger than allowed once inflated: the same as an oversized frame.
				return this.protocolError()
			}
		}
		const handler = this.onmessage
		if (!handler) return true
		const data = opcode === OP_TEXT ? message.toString('utf8') : message
		try {
			handler({ data })
		} catch {
			// A consumer bug must not desynchronize the frame stream.
		}
		return true
	}

	private sendClose(payload: Buffer): void {
		if (this.state === 'closed') return
		this.state = 'closing'
		this.fragments = []
		this.fragmentCompressed = false
		if (!this.closeSent) {
			this.closeSent = true
			this.write(encodeClientFrame(OP_CLOSE, payload))
		}
		this.socket.end()
		// A paused socket would never see the peer's EOF.
		this.socket.resume()
		this.clearTimer()
		this.timer = setTimeout(() => this.teardown(), CLOSE_GRACE_MS)
	}

	private protocolError(): false {
		this.fail()
		return false
	}

	private fail(): void {
		if (this.state === 'closed') return
		// Once either side has started closing, a reset is the expected end, not an error.
		if (this.state !== 'closing' && !this.userClosed && !this.errored) {
			this.errored = true
			this.emit(this.onerror)
		}
		this.teardown()
	}

	/** Drop the connection now; onclose follows asynchronously, as it does for WebSocket. */
	private teardown(): void {
		this.socket.destroy()
		setImmediate(() => this.finish())
	}

	private finish(): void {
		if (this.state === 'closed') return
		this.state = 'closed'
		this.clearTimer()
		this.received.clear()
		this.fragments = []
		this.handshake = null
		this.socket.destroy()
		this.emit(this.onclose)
	}

	private write(frame: Buffer): void {
		if (!this.socket.destroyed && this.socket.writable) this.socket.write(frame)
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}

	private emit(handler: (() => void) | null): void {
		try {
			handler?.()
		} catch {
			// Lifecycle observers cannot be allowed to break the transport.
		}
	}
}
