/**
 * Cache invalidation publisher
 *
 * Publishes invalidation messages to Redis pub/sub so the hosting-service
 * can clear its local caches (tiered storage, redirect rules) when a site
 * is updated or deleted via the firehose.
 */

import { createLogger } from '@wispplace/observability'
import Redis from 'ioredis'
import { config } from '../config'

const logger = createLogger('firehose-service')
const CHANNEL = 'wisp:cache-invalidate'

let publisher: Redis | null = null
let loggedMissingRedis = false

function getPublisher(): Redis | null {
	if (!config.redisUrl) {
		if (!loggedMissingRedis) {
			logger.warn('[CacheInvalidation] REDIS_URL not set; cache invalidation publishing disabled')
			loggedMissingRedis = true
		}
		return null
	}

	if (!publisher) {
		logger.info('[CacheInvalidation] Connecting to Redis for publishing')
		publisher = new Redis(config.redisUrl, {
			maxRetriesPerRequest: 2,
			enableReadyCheck: true,
		})

		publisher.on('error', (err) => {
			logger.error('[CacheInvalidation] Redis error', err)
		})

		publisher.on('ready', () => {
			logger.info('[CacheInvalidation] Redis publisher connected')
		})
	}

	return publisher
}

export async function publishCacheInvalidation(
	did: string,
	rkey: string,
	action: 'updating' | 'update' | 'delete' | 'settings',
	token?: string,
): Promise<void> {
	const redis = getPublisher()
	if (!redis) return

	try {
		const streamId = await redis.xadd(
			config.cacheInvalidationStream,
			'MAXLEN',
			'~',
			config.cacheInvalidationStreamMaxLen.toString(),
			'*',
			'did',
			did,
			'rkey',
			rkey,
			'action',
			action,
			...(token ? (['token', token] as const) : []),
			'ts',
			Date.now().toString(),
		)
		const message = JSON.stringify({ did, rkey, action, token, streamId })
		logger.debug(`[CacheInvalidation] Publishing ${action} for ${did}/${rkey} to ${CHANNEL} (stream ${streamId})`)
		await redis.publish(CHANNEL, message)
	} catch (err) {
		logger.error('[CacheInvalidation] Failed to publish', err)
	}
}

export async function enqueueSiteRevalidation(did: string, rkey: string, reason: string): Promise<boolean> {
	const redis = getPublisher()
	if (!redis) return false

	try {
		const streamId = await redis.xadd(
			config.revalidateStream,
			'*',
			'did',
			did,
			'rkey',
			rkey,
			'reason',
			reason,
			'ts',
			Date.now().toString(),
		)
		logger.info(`[Revalidate] Enqueued ${did}/${rkey} after firehose failure`, { reason, streamId })
		return true
	} catch (err) {
		logger.error('[Revalidate] Failed to enqueue site after firehose failure', err, { did, rkey, reason })
		return false
	}
}

export async function closeCacheInvalidationPublisher(): Promise<void> {
	if (publisher) {
		const toClose = publisher
		publisher = null
		await toClose.quit()
	}
}
