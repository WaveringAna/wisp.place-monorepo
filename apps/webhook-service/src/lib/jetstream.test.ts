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

	test('quarantines malformed bytes without cursor extraction, then resets only after an acked replay', async () => {
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
		FakeWebSocket.instances[0]?.open()
		FakeWebSocket.instances[0]?.message('{not json')
		await flush()
		expect(client.cursor).toBe(40)
		expect(client.isQuarantined).toBe(true)
		expect(client.protocolFailureCount).toBe(1)
		expect(client.failureKind).toBe('protocol')
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
