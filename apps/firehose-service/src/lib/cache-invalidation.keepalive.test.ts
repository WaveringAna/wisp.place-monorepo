import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test'
import { config } from '../config'

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

const { closeCacheInvalidationPublisher, enqueueSiteRevalidation } = await import('./cache-invalidation')
const originalRedisUrl = config.redisUrl

beforeEach(() => {
	jest.useFakeTimers()
	config.redisUrl = 'redis://redis.test:6379'
	FakeIORedis.instances = []
})

afterEach(async () => {
	await closeCacheInvalidationPublisher()
	config.redisUrl = originalRedisUrl
	jest.useRealTimers()
})

test('pings the idle publisher connection inside the 180 s proxy idle timeout', async () => {
	expect(await enqueueSiteRevalidation('did:plc:test', 'site', 'storage-miss:index.html')).toBe('enqueued')
	const [publisher] = FakeIORedis.instances

	jest.advanceTimersByTime(180_000)
	expect(publisher?.pings).toBe(3)

	publisher!.status = 'reconnecting'
	jest.advanceTimersByTime(60_000)
	expect(publisher?.pings).toBe(3)
})

test('stops pinging once the publisher is closed', async () => {
	await enqueueSiteRevalidation('did:plc:test', 'site', 'storage-miss:index.html')
	const [publisher] = FakeIORedis.instances
	await closeCacheInvalidationPublisher()

	jest.advanceTimersByTime(180_000)
	expect(publisher?.quitCalled).toBe(true)
	expect(publisher?.pings).toBe(0)
})
