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
import { isSiteDeleteTombstoneReason } from './revalidate-queue'

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
		const commandTimeout = Math.max(100, Math.min(5_000, Math.floor(config.leaderTtlMs / 4)))
		publisher = new Redis(config.redisUrl, {
			maxRetriesPerRequest: 0,
			enableReadyCheck: true,
			enableOfflineQueue: false,
			connectTimeout: commandTimeout,
			commandTimeout,
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

type RevalidationDedupeCategory = 'delete-tombstone' | 'settings' | 'rewrite-miss' | 'storage-miss' | 'full-repair'

/**
 * Whether direct firehose work is durably covered by the revalidation stream.
 * Only `enqueued` and `deduplicated` permit a caller to advance its own cursor.
 * `capacity` is explicit backpressure and must be retried without dropping work.
 */
export type SiteRevalidationEnqueueResult = 'enqueued' | 'deduplicated' | 'capacity' | 'unavailable'

export interface RevalidationQueueClient {
	/** Runs the revalidation enqueue script atomically. */
	eval(script: string, keyCount: number, ...args: string[]): PromiseLike<unknown>
}

// This script deliberately has no MAXLEN. A producer must never remove a
// pending consumer-group entry. Capacity is a hard backpressure boundary; ACK
// plus XDEL is the only normal removal path.
const ENQUEUE_REVALIDATION_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local found = redis.call('XRANGE', KEYS[2], existing, existing, 'COUNT', 1)
  if #found == 1 and found[1][1] == existing then return {0, existing} end
  redis.call('DEL', KEYS[1])
end
if redis.call('XLEN', KEYS[2]) >= tonumber(ARGV[1]) then return {-1, ''} end
local id = redis.call('XADD', KEYS[2], '*', 'did', ARGV[2], 'rkey', ARGV[3], 'reason', ARGV[4], 'ts', ARGV[5])
redis.call('SET', KEYS[1], id, 'EX', ARGV[6])
return {1, id}
`

function getRevalidationDedupeCategory(reason: string): RevalidationDedupeCategory {
	if (isSiteDeleteTombstoneReason(reason)) return 'delete-tombstone'
	if (reason.startsWith('firehose-settings-failed:')) return 'settings'
	if (reason.startsWith('rewrite-miss')) return 'rewrite-miss'
	if (reason.startsWith('storage-miss')) return 'storage-miss'
	return 'full-repair'
}

function revalidationErrorKind(error: unknown): string {
	if (error instanceof Error && error.name) return error.name
	return 'UnknownError'
}

function parseEnqueueResult(value: unknown): { status: number; streamId: string } | null {
	if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'string') return null
	return { status: value[0], streamId: value[1] }
}

export async function enqueueSiteRevalidationWithRedis(
	redis: RevalidationQueueClient,
	did: string,
	rkey: string,
	reason: string,
): Promise<SiteRevalidationEnqueueResult> {
	const dedupeCategory = getRevalidationDedupeCategory(reason)
	const dedupeKey = `revalidate:site:${dedupeCategory}:${did}:${rkey}`
	try {
		const outcome = parseEnqueueResult(
			await redis.eval(
				ENQUEUE_REVALIDATION_SCRIPT,
				2,
				dedupeKey,
				config.revalidateStream,
				config.revalidateStreamMaxLen.toString(),
				did,
				rkey,
				reason,
				Date.now().toString(),
				config.revalidateDedupeTtlSeconds.toString(),
			),
		)
		if (!outcome) {
			logger.error('[Revalidate] Redis enqueue script returned an invalid result', undefined, { did, rkey, reason })
			return 'unavailable'
		}
		if (outcome.status === 0 && outcome.streamId) return 'deduplicated'
		if (outcome.status === 1 && outcome.streamId) {
			logger.info(`[Revalidate] Enqueued ${did}/${rkey} after firehose failure`, { reason, streamId: outcome.streamId })
			return 'enqueued'
		}
		if (outcome.status === -1) {
			logger.warn(`[Revalidate] Queue capacity reached for ${did}/${rkey}`)
			return 'capacity'
		}
		return 'unavailable'
	} catch (err) {
		logger.error('[Revalidate] Failed to enqueue site after firehose failure', undefined, {
			did,
			rkey,
			reason,
			errorKind: revalidationErrorKind(err),
		})
		return 'unavailable'
	}
}

export async function enqueueSiteRevalidation(
	did: string,
	rkey: string,
	reason: string,
): Promise<SiteRevalidationEnqueueResult> {
	const redis = getPublisher()
	if (!redis) return 'unavailable'
	return enqueueSiteRevalidationWithRedis(redis, did, rkey, reason)
}

export async function closeCacheInvalidationPublisher(): Promise<void> {
	if (publisher) {
		const toClose = publisher
		publisher = null
		await toClose.quit()
	}
}
