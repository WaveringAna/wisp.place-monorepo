import { afterEach, describe, expect, test } from 'bun:test'
import { MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES } from './admission'
import { buildJetstreamSubscriptionUrl, JetstreamClient, parseJetstreamEvent } from './jetstream'

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const REV = '3lq6x5f2abcde'

class FakeWebSocket {
	static instances: FakeWebSocket[] = []
	readonly url: string
	onopen: (() => void) | null = null
	onclose: (() => void) | null = null
	onerror: (() => void) | null = null
	onmessage: ((message: { data: unknown }) => void) | null = null
	closeImmediately = true
	closeRequested = false
	#closed = false

	constructor(url: string) {
		this.url = url
		FakeWebSocket.instances.push(this)
	}

	open(): void {
		this.onopen?.()
	}

	message(value: unknown): void {
		this.onmessage?.({ data: value })
	}

	close(): void {
		this.closeRequested = true
		if (this.closeImmediately) this.finishClose()
	}

	finishClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.onclose?.()
	}
}

const realWebSocket = globalThis.WebSocket

function event(timeUs: number) {
	return JSON.stringify({
		did: DID,
		time_us: timeUs,
		kind: 'commit',
		commit: { rev: REV, operation: 'create', collection: 'app.bsky.feed.post', rkey: 'one', record: {} },
	})
}

async function flush(): Promise<void> {
	for (let index = 0; index < 6; index++) await Promise.resolve()
}

afterEach(() => {
	globalThis.WebSocket = realWebSocket
	FakeWebSocket.instances = []
})

describe('JetstreamClient durable acknowledgement and protocol quarantine', () => {
	test('does not advance cursor until handler and durable acknowledgement resolve', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		let release: (() => void) | undefined
		const processed = new Promise<void>((resolve) => {
			release = resolve
		})
		const acknowledged: number[] = []
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 10,
			onEvent: () => processed,
			onAcknowledged: async (value) => {
				acknowledged.push(value.time_us)
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		socket?.open()
		socket?.message(event(11))
		await flush()
		expect(client.cursor).toBe(10)
		expect(acknowledged).toEqual([])
		release?.()
		await flush()
		expect(client.cursor).toBe(11)
		expect(acknowledged).toEqual([11])
		client.destroy()
	})

	test('acknowledges the longest completed prefix with one durable cursor write', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		const acknowledged: number[] = []
		let release: (() => void) | undefined
		const firstWrite = new Promise<void>((resolve) => {
			release = resolve
		})
		let writes = 0
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 50,
			concurrency: 4,
			onEvent: async () => undefined,
			onAcknowledged: async (value) => {
				writes++
				acknowledged.push(value.time_us)
				if (writes === 1) await firstWrite
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		socket?.open()
		socket?.message(event(51))
		await flush()
		// The first write is in flight; the next events complete behind it.
		socket?.message(event(52))
		socket?.message(event(53))
		await flush()
		expect(acknowledged).toEqual([51])
		release?.()
		await flush()
		// 52 and 53 are one contiguous completed prefix: one write, latest cursor.
		expect(acknowledged).toEqual([51, 53])
		expect(client.cursor).toBe(53)
		expect(client.queued).toBe(0)
		client.destroy()
	})

	test('quarantines malformed bytes, ignores late frames, then resets only after an acked replay', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		const acknowledgements: number[] = []
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 40,
			onEvent: async () => undefined,
			onAcknowledged: async (value) => {
				acknowledgements.push(value.time_us)
			},
			reconnectMinMs: 1,
			reconnectMaxMs: 1,
			reconnectMaxExponent: 0,
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		if (!socket) throw new Error('missing test socket')
		socket.closeImmediately = false
		socket.open()
		socket.message('{not json')
		await flush()
		expect(client.cursor).toBe(40)
		expect(client.isQuarantined).toBe(true)
		expect(client.protocolFailureCount).toBe(1)
		expect(client.failureKind).toBe('protocol')
		socket.message(event(41))
		await flush()
		expect(client.queued).toBe(0)
		socket.finishClose()
		await Bun.sleep(5)
		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
		const replay = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
		replay?.open()
		replay?.message(event(41))
		await flush()
		expect(client.cursor).toBe(41)
		expect(client.isQuarantined).toBe(false)
		expect(client.protocolFailureCount).toBe(0)
		client.destroy()
	})

	test('retains a full bounded queue, drains it in order, then reconnects from the latest ack', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		let releaseFirst: (() => void) | undefined
		let releaseSecond: (() => void) | undefined
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const second = new Promise<void>((resolve) => {
			releaseSecond = resolve
		})
		const processed: number[] = []
		const acknowledged: number[] = []
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 10,
			maxQueue: 2,
			reconnectMinMs: 1,
			reconnectMaxMs: 1,
			reconnectMaxExponent: 0,
			onEvent: async (value) => {
				const time = value.time_us
				processed.push(time)
				if (time === 11) await first
				if (time === 12) await second
			},
			onAcknowledged: async (value) => {
				acknowledged.push(value.time_us)
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		socket?.open()
		socket?.message(event(11))
		socket?.message(event(12))
		await flush()
		expect(client.queued).toBe(2)
		expect(client.failureKind).toBe('queue')
		expect(client.isConnected).toBe(false)
		expect(FakeWebSocket.instances).toHaveLength(1)
		// A frame delivered after the close is ignored locally and will be replayed
		// from the durable cursor on the replacement connection.
		socket?.message(event(13))
		releaseFirst?.()
		await flush()
		releaseSecond?.()
		await flush()
		expect(processed).toEqual([11, 12])
		expect(acknowledged).toEqual([11, 12])
		expect(client.cursor).toBe(12)
		await Bun.sleep(5)
		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
		const replay = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
		expect(replay?.url).toContain('cursor=12')
		replay?.open()
		replay?.message(event(13))
		await flush()
		expect(processed).toEqual([11, 12, 13])
		client.destroy()
	})

	test('ignores late frames after retained work fails, then reconnects after asynchronous close', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		let release: (() => void) | undefined
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 20,
			maxQueue: 2,
			reconnectMinMs: 1,
			reconnectMaxMs: 1,
			reconnectMaxExponent: 0,
			onEvent: async (value) => {
				if (value.time_us === 21) await pending
			},
			onAcknowledged: async () => {
				throw new Error('cursor store unavailable')
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		if (!socket) throw new Error('missing test socket')
		socket.closeImmediately = false
		socket.open()
		socket.message(event(21))
		socket.message(event(22))
		await flush()
		release?.()
		await flush()
		expect(client.failureKind).toBe('cursor')
		expect(client.isConnected).toBe(false)
		expect(client.queued).toBe(0)
		expect(socket.closeRequested).toBe(true)
		// The peer can still deliver buffered frames before its close callback.
		// A failed client must ignore them or it wedges on an undrainable queue.
		socket.message(event(23))
		await flush()
		expect(client.queued).toBe(0)
		socket.finishClose()
		await Bun.sleep(5)
		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
		expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]?.url).toContain('cursor=20')
		client.destroy()
	})

	test('waits for sibling handlers before replaying a failure after disconnect', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		let rejectFirst: ((error: Error) => void) | undefined
		let releaseSecond: (() => void) | undefined
		const first = new Promise<void>((_resolve, reject) => {
			rejectFirst = reject
		})
		const second = new Promise<void>((resolve) => {
			releaseSecond = resolve
		})
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 20,
			reconnectMinMs: 1,
			reconnectMaxMs: 1,
			reconnectMaxExponent: 0,
			onEvent: async (value) => {
				if (value.time_us === 21) await first
				if (value.time_us === 22) await second
			},
			onAcknowledged: async () => undefined,
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		if (!socket) throw new Error('missing test socket')
		socket.open()
		socket.message(event(21))
		socket.message(event(22))
		await flush()
		// The relay disconnects while both handlers are still active.
		socket.finishClose()
		rejectFirst?.(new Error('handler failed'))
		await flush()
		expect(client.failureKind).toBe('handler')
		expect(client.queued).toBe(0)
		expect(FakeWebSocket.instances).toHaveLength(1)
		releaseSecond?.()
		await flush()
		await Bun.sleep(5)
		expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
		expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]?.url).toContain('cursor=20')
		client.destroy()
	})

	test('rejects malformed relay fields and caller query injection', () => {
		expect(parseJetstreamEvent({ did: DID, time_us: 1, kind: 'commit', commit: { rev: 'not-a-tid' } })).toBeNull()
		expect(parseJetstreamEvent({ did: DID, time_us: 1.5, kind: 'identity' })).toBeNull()
		expect(
			() =>
				new JetstreamClient({
					url: 'wss://relay.example/subscribe?wantedDids=did:plc:evil',
					onEvent: async () => undefined,
				}),
		).toThrow('Unsafe Jetstream relay URL')
	})

	test('uses exact encoded URL bytes at the subscription hard boundary', () => {
		const options = { url: 'wss://relay.example/', wantedDids: [DID] }
		const cursor = Number.MAX_SAFE_INTEGER
		const base = buildJetstreamSubscriptionUrl(options, cursor)
		const fill = MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES - Buffer.byteLength(base)
		expect(fill).toBeGreaterThan(0)
		const boundary = buildJetstreamSubscriptionUrl(
			{ ...options, url: `wss://relay.example/${'a'.repeat(fill)}` },
			cursor,
		)
		expect(Buffer.byteLength(boundary)).toBe(MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES)
		expect(() =>
			buildJetstreamSubscriptionUrl({ ...options, url: `wss://relay.example/${'a'.repeat(fill + 1)}` }, cursor),
		).toThrow('subscription URL limit')
	})
})
