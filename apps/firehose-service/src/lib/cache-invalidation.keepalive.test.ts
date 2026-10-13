import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import { config } from '../config'
import { createCacheInvalidationPublisher } from './cache-invalidation'

class FakeIORedis {
	status = 'ready'
	pings = 0
	quitCalled = false

	on(): this {
		return this
	}

	once(): this {
		return this
	}

	removeListener(): this {
		return this
	}

	async ping(): Promise<string> {
		this.pings++
		return 'PONG'
	}

	async eval(): Promise<unknown> {
		return [1, '1-0']
	}

	async xadd(): Promise<string> {
		return '1-0'
	}

	async publish(): Promise<number> {
		return 1
	}

	async quit(): Promise<string> {
		this.quitCalled = true
		this.status = 'end'
		return 'OK'
	}
}

let instances: FakeIORedis[] = []
const { closeCacheInvalidationPublisher, enqueueSiteRevalidation } = createCacheInvalidationPublisher({
	config: { ...config, redisUrl: 'redis://redis.test:6379' },
	createRedis: () => {
		const redis = new FakeIORedis()
		instances.push(redis)
		return redis
	},
})

beforeEach(() => {
	jest.useFakeTimers()
	instances = []
})

afterEach(async () => {
	try {
		await closeCacheInvalidationPublisher()
	} finally {
		jest.useRealTimers()
	}
})

test('pings the idle publisher connection inside the 180 s proxy idle timeout', async () => {
	expect(await enqueueSiteRevalidation('did:plc:test', 'site', 'storage-miss:index.html')).toBe('enqueued')
	const [publisher] = instances

	jest.advanceTimersByTime(180_000)
	expect(publisher?.pings).toBe(3)

	publisher!.status = 'reconnecting'
	jest.advanceTimersByTime(60_000)
	expect(publisher?.pings).toBe(3)
})

test('stops pinging once the publisher is closed', async () => {
	await enqueueSiteRevalidation('did:plc:test', 'site', 'storage-miss:index.html')
	const [publisher] = instances
	await closeCacheInvalidationPublisher()

	jest.advanceTimersByTime(180_000)
	expect(publisher?.quitCalled).toBe(true)
	expect(publisher?.pings).toBe(0)
})
