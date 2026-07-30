import { createLogger } from '@wispplace/observability'
import { RedisClient } from 'bun'
import { config } from '../config'

const logger = createLogger('webhook-service:redis')

export interface WebhookEvent {
	ownerDid: string
	rkey: string
	url: string
	eventKind: string
	eventDid: string
	eventCollection: string
	eventRkey: string
	cid?: string
	deliveredAt: string
	status: 'ok' | 'failed'
}

let publisher: RedisClient | null = null
let loggedMissingRedis = false

function getPublisher(): RedisClient | null {
	if (!config.redisUrl) {
		if (!loggedMissingRedis) {
			logger.warn('[Redis] REDIS_URL not set — webhook event publishing disabled')
			loggedMissingRedis = true
		}
		return null
	}

	if (!publisher) {
		logger.info('[Redis] Connecting')
		publisher = new RedisClient(config.redisUrl)
		publisher.onconnect = () => logger.info('[Redis] Publisher connected')
		publisher.onclose = (err) => {
			if (err) logger.error('[Redis] Publisher disconnected', err)
		}
	}

	return publisher
}

/** Publish a webhook delivery event to Redis. Fire-and-forget; never throws. */
export async function publishWebhookEvent(event: WebhookEvent): Promise<void> {
	const client = getPublisher()
	if (!client) return
	try {
		await client.publish(config.webhookEventsChannel, JSON.stringify(event))
	} catch (err) {
		logger.error('[Redis] Failed to publish webhook event', err)
	}
}

export function closeRedisPublisher(): void {
	publisher?.close()
	publisher = null
}
