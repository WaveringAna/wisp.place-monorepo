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

describe('JetstreamClient durable batch acknowledgement and protocol quarantine', () => {
	test('does not advance the cursor until the batch commits', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		let release: (() => void) | undefined
		const committed = new Promise<void>((resolve) => {
			release = resolve
		})
		const batches: number[][] = []
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 10,
			onEvents: (events) => {
				batches.push(events.map((value) => value.time_us))
				return committed
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		socket?.open()
		socket?.message(event(11))
		await flush()
		expect(client.cursor).toBe(10)
		release?.()
		await flush()
		expect(batches).toEqual([[11]])
		expect(client.cursor).toBe(11)
		client.destroy()
	})

	test('hands the queued events to one batch and advances to its last event', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		const batches: number[][] = []
		let release: (() => void) | undefined
		const firstBatch = new Promise<void>((resolve) => {
			release = resolve
		})
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 50,
			onEvents: (events) => {
				batches.push(events.map((value) => value.time_us))
				return batches.length === 1 ? firstBatch : Promise.resolve()
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		socket?.open()
		socket?.message(event(51))
		await flush()
		// These arrive while the first batch is still committing.
		socket?.message(event(52))
		socket?.message(event(53))
		await flush()
		expect(batches).toEqual([[51]])
		release?.()
		await flush()
		// One transaction, one cursor write, both remaining events.
		expect(batches).toEqual([[51], [52, 53]])
		expect(client.cursor).toBe(53)
		expect(client.queued).toBe(0)
		client.destroy()
	})

	test('never hands over more than the batch bound at once', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		const sizes: number[] = []
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 80,
			batchMax: 2,
			maxQueue: 8,
			onEvents: async (events) => {
				sizes.push(events.length)
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		socket?.open()
		for (const time of [81, 82, 83, 84, 85]) socket?.message(event(time))
		await flush()
		expect(Math.max(...sizes)).toBeLessThanOrEqual(2)
		expect(client.cursor).toBe(85)
		client.destroy()
	})

	test('stays healthy while a bounded queue drains, and stops when progress stalls', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		let release: (() => void) | undefined
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 60,
			maxQueue: 2,
			batchMax: 1,
			onEvents: () => held,
			progressStaleMs: 60_000,
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		if (!socket) throw new Error('missing test socket')
		socket.closeImmediately = false
		socket.open()
		socket.message(event(61))
		socket.message(event(62))
		await flush()
		// Backpressure closed the socket; the retained queue is still real work.
		expect(client.isConnected).toBe(false)
		expect(client.failureKind).toBe('queue')
		release?.()
		await flush()
		expect(client.cursor).toBe(62)
		expect(client.isProgressing).toBe(true)

		const stalled = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			onEvents: async () => undefined,
			progressStaleMs: 1,
		})
		// Never acknowledged anything and not connected: not serving.
		expect(stalled.isProgressing).toBe(false)
		client.destroy()
		stalled.destroy()
	})

	test('retries a failed batch in place instead of replaying the stream', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		let failures = 0
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 70,
			batchRetryDelayMs: 1,
			onEvents: async () => {
				if (failures === 0) {
					failures++
					throw new Error('transient')
				}
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		socket?.open()
		socket?.message(event(71))
		socket?.message(event(72))
		await flush()
		await Bun.sleep(10)
		await flush()
		expect(failures).toBe(1)
		// The failure never reached the stream: no replay connection, nothing dropped.
		expect(FakeWebSocket.instances.length).toBe(1)
		expect(client.cursor).toBe(72)
		expect(client.queued).toBe(0)
		client.destroy()
	})

	test('quarantines malformed bytes, ignores late frames, then resets only after an acked replay', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 40,
			onEvents: async () => undefined,
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
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const processed: number[] = []
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 10,
			maxQueue: 2,
			batchMax: 1,
			reconnectMinMs: 1,
			reconnectMaxMs: 1,
			reconnectMaxExponent: 0,
			onEvents: async (events) => {
				for (const value of events) processed.push(value.time_us)
				if (events[0]?.time_us === 11) await first
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
		expect(processed).toEqual([11, 12])
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

	test('replays from the last durable batch when a batch keeps failing', async () => {
		globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
		const client = new JetstreamClient({
			url: 'wss://relay.example/subscribe',
			cursor: 20,
			reconnectMinMs: 1,
			reconnectMaxMs: 1,
			reconnectMaxExponent: 0,
			// This exercises stream-level failure, so give the batch no retries.
			batchMaxAttempts: 1,
			onEvents: async () => {
				throw new Error('durable batch failed')
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		expect(socket).toBeDefined()
		if (!socket) throw new Error('missing test socket')
		socket.closeImmediately = false
		socket.open()
		socket.message(event(21))
		await flush()
		expect(client.failureKind).toBe('handler')
		expect(client.queued).toBe(0)
		expect(client.cursor).toBe(20)
		socket.finishClose()
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
					onEvents: async () => undefined,
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
