import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { createRevalidateQueue, resolveRevalidateQueueConfig } from './revalidate-queue'

// Redis is the one piece faked here, at the connection the queue opens.

class FakeIORedis {
	static instances: FakeIORedis[] = []
	status = 'ready'
	pings = 0
	quitCalled = false

	constructor() {
		FakeIORedis.instances.push(this)
	}

	on(): this {
		return this
	}

	async ping(): Promise<string> {
		this.pings++
		return 'PONG'
	}

	async eval(): Promise<unknown> {
		return [1, '1-0']
	}

	async quit(): Promise<string> {
		this.quitCalled = true
		this.status = 'end'
		return 'OK'
	}
}

const { closeRevalidateQueue, enqueueRevalidate } = createRevalidateQueue({
	config: resolveRevalidateQueueConfig({ REDIS_URL: 'redis://redis.test:6379' }),
	connect: () => new FakeIORedis(),
})

beforeEach(() => {
	jest.useFakeTimers()
	FakeIORedis.instances = []
})

afterEach(async () => {
	try {
		await closeRevalidateQueue()
	} finally {
		jest.useRealTimers()
	}
})

test('pings the idle revalidate queue connection inside the 180 s proxy idle timeout', async () => {
	await enqueueRevalidate('did:plc:test', 'site', 'storage-miss:index.html')
	const [client] = FakeIORedis.instances

	jest.advanceTimersByTime(180_000)
	expect(client?.pings).toBe(3)

	client!.status = 'reconnecting'
	jest.advanceTimersByTime(60_000)
	expect(client?.pings).toBe(3)
})

test('stops pinging once the queue is closed', async () => {
	await enqueueRevalidate('did:plc:test', 'site', 'storage-miss:index.html')
	const [client] = FakeIORedis.instances
	await closeRevalidateQueue()

	jest.advanceTimersByTime(180_000)
	expect(client?.quitCalled).toBe(true)
	expect(client?.pings).toBe(0)
})
