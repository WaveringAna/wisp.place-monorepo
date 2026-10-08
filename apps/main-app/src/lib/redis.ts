import { startRedisKeepalive } from '@wispplace/constants'
import { createLogger } from '@wispplace/observability'
import { RedisClient } from 'bun'

const logger = createLogger('main-app:redis')

let client: RedisClient | null = null
let connectionPromise: Promise<RedisClient> | null = null
let stopKeepalive: (() => void) | null = null

type RedisClientFactory = (url: string) => RedisClient
const defaultRedisClientFactory: RedisClientFactory = (url) => new RedisClient(url)
let redisClientFactory: RedisClientFactory = defaultRedisClientFactory

/** Test seam for exercising the shared client without a live Redis server. */
export function setRedisClientFactoryForTests(factory?: RedisClientFactory): void {
	if (client) throw new Error('Cannot replace an active Redis client')
	redisClientFactory = factory ?? defaultRedisClientFactory
}

/** Returns the shared Redis client, creating it lazily. Returns null if REDIS_URL is not set. */
export function getRedisClient(): RedisClient | null {
	const redisUrl = Bun.env.REDIS_URL
	if (!redisUrl) return null

	if (!client) {
		logger.info('[Redis] Connecting')
		const created = redisClientFactory(redisUrl)
		created.onconnect = () => logger.info('[Redis] Connected')
		created.onclose = (error) => {
			if (client === created) connectionPromise = null
			if (error) logger.error('[Redis] Disconnected with error', error)
		}
		client = created
		// Writes are rare, so without a ping haproxy cuts the idle connection every 180 s.
		stopKeepalive = startRedisKeepalive(() => (created.connected ? created.send('PING', []) : undefined), {
			onError: (error) =>
				logger.warn('[Redis] Keepalive ping failed', {
					errorName: error instanceof Error ? error.name : 'UnknownError',
				}),
		})
	}

	return client
}

/** Wait until the shared client is connected before allowing a command. */
export async function getConnectedRedisClient(): Promise<RedisClient | null> {
	const target = getRedisClient()
	if (!target) return null

	connectionPromise ??= target
		.connect()
		.then(() => target)
		.catch((error) => {
			if (client === target) closeRedisClient()
			throw error
		})
	return await connectionPromise
}

export function closeRedisClient(): void {
	const target = client
	client = null
	connectionPromise = null
	stopKeepalive?.()
	stopKeepalive = null
	target?.close()
}
