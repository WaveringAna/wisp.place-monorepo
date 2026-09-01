import { afterEach, describe, expect, test } from 'bun:test'

process.env.NODE_ENV = 'test'
process.env.WEBHOOK_ALLOW_INSECURE_DEV = '1'
process.env.REDIS_URL = 'redis://redis.example:6379'

const redis = await import('./redis')

type FakeRedis = {
	url: string
	connected: boolean
	connectCalls: number
	publishes: Array<{ channel: string; body: string }>
	onconnect: (() => void) | null
	onclose: (() => void) | null
	connect: () => Promise<void>
	publish: (channel: string, body: string) => Promise<string>
	close: () => void
}

const fakeClients: FakeRedis[] = []

function createFakeRedis(url: string): FakeRedis {
	const client: FakeRedis = {
		url,
		connected: false,
		connectCalls: 0,
		publishes: [],
		onconnect: null,
		onclose: null,
		async connect() {
			client.connectCalls++
			client.connected = true
			client.onconnect?.()
		},
		async publish(channel, body) {
			if (!client.connected) throw new Error('not connected')
			client.publishes.push({ channel, body })
			return 'OK'
		},
		close() {
			client.connected = false
			client.onclose?.()
		},
	}
	fakeClients.push(client)
	return client
}

async function flush(): Promise<void> {
	for (let index = 0; index < 6; index++) await Promise.resolve()
}

const event = {
	ownerDid: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
	rkey: 'hook',
	url: 'https://receiver.example/hook',
	eventKind: 'create' as const,
	eventDid: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
	eventCollection: 'app.bsky.feed.post',
	eventRkey: 'post',
	deliveredAt: '2025-01-01T00:00:00.000Z',
	status: 'ok' as const,
}

afterEach(() => {
	redis.resetRedisPublisherForTests()
	redis.setRedisClientFactoryForTests()
	fakeClients.length = 0
})

describe('Redis publisher connection readiness', () => {
	test('awaits the lazy Redis connection before publishing and reports readiness', async () => {
		redis.setRedisClientFactoryForTests((url) => createFakeRedis(url) as unknown as import('bun').RedisClient)
		expect(redis.getRedisPublisherHealth()).toMatchObject({ configured: true, connected: false })

		// The first call starts the lazy connection and is intentionally bounded;
		// it must not wait or buffer while the handshake is in flight.
		expect(await redis.publishWebhookEvent(event)).toEqual({ published: false, dropped: true })
		await flush()
		expect(fakeClients[0]?.connectCalls).toBe(1)
		expect(redis.getRedisPublisherHealth()).toMatchObject({ configured: true, connected: true })
		expect(await redis.publishWebhookEvent(event)).toEqual({ published: true, dropped: false })
		expect(fakeClients[0]?.publishes).toHaveLength(1)
	})
})
