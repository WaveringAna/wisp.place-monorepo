import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import type { RedisClient } from 'bun'
import { closeRedisClient, getConnectedRedisClient, getRedisClient, setRedisClientFactoryForTests } from './redis'

class FakeRedisClient {
	connected = false
	commands: string[] = []
	closed = false
	onconnect: (() => void) | null = null
	onclose: ((error: Error) => void) | null = null

	async connect(): Promise<void> {
		this.connected = true
	}

	send(command: string): Promise<string> {
		this.commands.push(command)
		return Promise.resolve('PONG')
	}

	close(): void {
		this.closed = true
		this.connected = false
	}
}

describe('main-app Redis keepalive', () => {
	const originalRedisUrl = Bun.env.REDIS_URL
	let created: FakeRedisClient[]

	beforeEach(() => {
		jest.useFakeTimers()
		Bun.env.REDIS_URL = 'redis://redis.test:6379'
		created = []
		setRedisClientFactoryForTests(() => {
			const fake = new FakeRedisClient()
			created.push(fake)
			return fake as unknown as RedisClient
		})
	})

	afterEach(() => {
		closeRedisClient()
		setRedisClientFactoryForTests()
		jest.useRealTimers()
		if (originalRedisUrl === undefined) delete Bun.env.REDIS_URL
		else Bun.env.REDIS_URL = originalRedisUrl
	})

	test('pings an idle connection well inside the 180 s proxy idle timeout', async () => {
		await getConnectedRedisClient()
		const [client] = created

		jest.advanceTimersByTime(59_000)
		expect(client?.commands).toEqual([])

		jest.advanceTimersByTime(1_000)
		expect(client?.commands).toEqual(['PING'])

		jest.advanceTimersByTime(120_000)
		expect(client?.commands).toEqual(['PING', 'PING', 'PING'])
	})

	test('skips pings while the client is reconnecting', () => {
		getRedisClient()
		jest.advanceTimersByTime(180_000)
		expect(created[0]?.commands).toEqual([])
	})

	test('stops pinging once the client is closed', async () => {
		await getConnectedRedisClient()
		const [client] = created
		closeRedisClient()

		jest.advanceTimersByTime(180_000)
		expect(client?.closed).toBe(true)
		expect(client?.commands).toEqual([])
	})
})
