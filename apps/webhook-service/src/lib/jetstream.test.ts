import '../test-env'
import { afterEach, describe, expect, test } from 'bun:test'
import { MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES } from './admission'
import { buildJetstreamSubscriptionUrl, JetstreamClient, parseJetstreamEvent } from './jetstream'
import type { JetstreamSocketLike } from './jetstream-socket'

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
	// Recorded but not enforced, so a test can still deliver past a pause.
	paused = false
	#closed = false

	constructor(url: string) {
		this.url = url
		FakeWebSocket.instances.push(this)
	}

	open(): void {
		this.onopen?.()
	}

	pause(): void {
		this.paused = true
	}

	resume(): void {
		this.paused = false
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

const fakeSocket = { createSocket: (url: string) => new FakeWebSocket(url) as unknown as JetstreamSocketLike }

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
	FakeWebSocket.instances = []
})

describe('JetstreamClient durable batch acknowledgement and protocol quarantine', () => {
	test('does not advance the cursor until the batch commits', async () => {
		let release: (() => void) | undefined
		const committed = new Promise<void>((resolve) => {
			release = resolve
		})
		const batches: number[][] = []
		const client = new JetstreamClient({
			...fakeSocket,
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
		const batches: number[][] = []
		let release: (() => void) | undefined
		const firstBatch = new Promise<void>((resolve) => {
			release = resolve
		})
		const client = new JetstreamClient({
			...fakeSocket,
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
		const sizes: number[] = []
		const client = new JetstreamClient({
			...fakeSocket,
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
		let release: (() => void) | undefined
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const client = new JetstreamClient({
			...fakeSocket,
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
		// A full queue pauses reads; the connection stays open while it drains.
		expect(socket.paused).toBe(true)
		expect(client.isConnected).toBe(true)
		release?.()
		await flush()
		expect(client.cursor).toBe(62)
		expect(client.isProgressing).toBe(true)

		const stalled = new JetstreamClient({
			...fakeSocket,
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
		let failures = 0
		const client = new JetstreamClient({
			...fakeSocket,
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
		const client = new JetstreamClient({
			...fakeSocket,
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

	test('pauses reads at a full queue and resumes them at half, on the same connection', async () => {
		const releases: Array<() => void> = []
		const processed: number[] = []
		const client = new JetstreamClient({
			...fakeSocket,
			url: 'wss://relay.example/subscribe',
			cursor: 10,
			maxQueue: 4,
			batchMax: 1,
			onEvents: async (events) => {
				await new Promise<void>((resolve) => releases.push(resolve))
				for (const value of events) processed.push(value.time_us)
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		socket?.open()
		for (const timeUs of [11, 12, 13, 14]) socket?.message(event(timeUs))
		await flush()
		expect(socket?.paused).toBe(true)
		expect(socket?.closeRequested).toBe(false)
		releases.shift()?.()
		await flush()
		// 11 acked, three still queued: more than half, so reads stay paused.
		expect(socket?.paused).toBe(true)
		releases.shift()?.()
		await flush()
		expect(socket?.paused).toBe(false)
		socket?.message(event(15))
		for (let index = 0; index < 3; index++) {
			releases.shift()?.()
			await flush()
		}
		expect(processed).toEqual([11, 12, 13, 14, 15])
		expect(client.cursor).toBe(15)
		expect(FakeWebSocket.instances).toHaveLength(1)
		expect(client.failureKind).toBeUndefined()
		client.destroy()
	})

	test('a frame delivered past the pause closes, then resumes after the newest queued event without backoff', async () => {
		const releases: Array<() => void> = []
		const processed: number[] = []
		const client = new JetstreamClient({
			...fakeSocket,
			url: 'wss://relay.example/subscribe',
			cursor: 10,
			maxQueue: 4,
			batchMax: 1,
			// Any backoff would outlast the test: flow control must not wait.
			reconnectMinMs: 60_000,
			reconnectMaxMs: 60_000,
			onEvents: async (events) => {
				await new Promise<void>((resolve) => releases.push(resolve))
				for (const value of events) processed.push(value.time_us)
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		socket?.open()
		// The fake ignores pause(), so the fifth frame reaches a full queue.
		for (const timeUs of [11, 12, 13, 14, 15]) socket?.message(event(timeUs))
		await flush()
		expect(client.failureKind).toBe('queue')
		expect(socket?.closeRequested).toBe(true)
		releases.shift()?.()
		await flush()
		expect(FakeWebSocket.instances).toHaveLength(1)
		releases.shift()?.()
		await flush()
		expect(processed).toEqual([11, 12])
		expect(client.cursor).toBe(12)
		const resumed = FakeWebSocket.instances[1]
		// 15 was dropped at the full queue, so playback starts at the newest queued event.
		expect(resumed?.url).toContain('cursor=14')
		resumed?.open()
		resumed?.message(event(15))
		for (let index = 0; index < 3; index++) {
			releases.shift()?.()
			await flush()
		}
		expect(processed).toEqual([11, 12, 13, 14, 15])
		client.destroy()
	})

	test('a batch that keeps failing after a flow-control resume still replays from the last ack', async () => {
		let releaseFirst: (() => void) | undefined
		const client = new JetstreamClient({
			...fakeSocket,
			url: 'wss://relay.example/subscribe',
			cursor: 10,
			maxQueue: 2,
			batchMax: 1,
			batchMaxAttempts: 1,
			reconnectMinMs: 1,
			reconnectMaxMs: 1,
			reconnectMaxExponent: 0,
			onEvents: async (events) => {
				if (events[0]?.time_us === 11) return new Promise<void>((resolve) => (releaseFirst = resolve))
				throw new Error('durable batch failed')
			},
		})
		client.start()
		const socket = FakeWebSocket.instances[0]
		socket?.open()
		for (const timeUs of [11, 12, 13]) socket?.message(event(timeUs))
		await flush()
		releaseFirst?.()
		await flush()
		expect(FakeWebSocket.instances[1]?.url).toContain('cursor=12')
		expect(client.failureKind).toBe('handler')
		expect(client.cursor).toBe(11)
		await Bun.sleep(5)
		expect(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]?.url).toContain('cursor=11')
		client.destroy()
	})

	test('replays from the last durable batch when a batch keeps failing', async () => {
		const client = new JetstreamClient({
			...fakeSocket,
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
					...fakeSocket,
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
