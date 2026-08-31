import { createLogger } from '@wispplace/observability'
import { RedisClient } from 'bun'

const logger = createLogger('main-app:redis')

let client: RedisClient | null = null
let connectionPromise: Promise<RedisClient> | null = null

/** Returns the shared Redis client, creating it lazily. Returns null if REDIS_URL is not set. */
export function getRedisClient(): RedisClient | null {
	const redisUrl = Bun.env.REDIS_URL
	if (!redisUrl) return null

	if (!client) {
		logger.info('[Redis] Connecting')
		const created = new RedisClient(redisUrl)
		created.onconnect = () => logger.info('[Redis] Connected')
		created.onclose = (error) => {
			if (client === created) connectionPromise = null
			if (error) logger.error('[Redis] Disconnected with error', error)
		}
		client = created
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
			if (client === target) {
				target.close()
				client = null
				connectionPromise = null
			}
			throw error
		})
	return await connectionPromise
}

export function closeRedisClient(): void {
	const target = client
	client = null
	connectionPromise = null
	target?.close()
}
