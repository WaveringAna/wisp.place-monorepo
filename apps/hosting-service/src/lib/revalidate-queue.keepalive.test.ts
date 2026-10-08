import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test'

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

mock.module('ioredis', () => ({ default: FakeIORedis }))

process.env.REDIS_URL = 'redis://redis.test:6379'
const { closeRevalidateQueue, enqueueRevalidate } = await import('./revalidate-queue')

beforeEach(() => {
	jest.useFakeTimers()
	FakeIORedis.instances = []
})

afterEach(async () => {
	await closeRevalidateQueue()
	jest.useRealTimers()
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
