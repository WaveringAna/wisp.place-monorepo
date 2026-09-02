/**
 * Cache invalidation publisher
 *
 * Publishes invalidation messages to Redis pub/sub so the hosting-service
 * can clear its local caches (tiered storage, redirect rules) when a site
 * is updated or deleted via the firehose.
 */

import {
	DEFAULT_CACHE_INVALIDATION_CHANNEL,
	publishCacheInvalidationEvent,
	revalidationQuarantineKey,
	revalidationSiteVersionKey,
} from '@wispplace/constants'
import { createLogger } from '@wispplace/observability'
import Redis from 'ioredis'
import { config } from '../config'
import { isSiteDeleteTombstoneReason } from './revalidate-queue'

const logger = createLogger('firehose-service')

let publisher: Redis | null = null
let publisherReadyTimeoutMs = 5_000
let loggedMissingRedis = false

export interface CacheInvalidationPublisherReadiness {
	readonly status: string
	once(event: string, listener: (...args: unknown[]) => void): unknown
	removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/** Wait for the eager ioredis connection before issuing commands with offline queuing disabled. */
export async function waitForCacheInvalidationPublisherReady(
	redis: CacheInvalidationPublisherReadiness,
	timeoutMs: number,
): Promise<void> {
	if (redis.status === 'ready') return

	await new Promise<void>((resolve, reject) => {
		let settled = false
		const finish = (error?: unknown) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			redis.removeListener('ready', onReady)
			redis.removeListener('error', onError)
			if (error === undefined) resolve()
			else reject(error)
		}
		const onReady = () => finish()
		const onError = (error: unknown) => finish(error)
		const timer = setTimeout(() => finish(new Error(`Redis publisher was not ready within ${timeoutMs}ms`)), timeoutMs)
		redis.once('ready', onReady)
		redis.once('error', onError)
	})
}

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
		publisherReadyTimeoutMs = commandTimeout
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
		await waitForCacheInvalidationPublisherReady(redis, publisherReadyTimeoutMs)
		const streamId = await publishCacheInvalidationEvent(
			redis,
			{ did, rkey, action, token },
			DEFAULT_CACHE_INVALIDATION_CHANNEL,
			config.cacheInvalidationStream,
			config.cacheInvalidationStreamMaxLen,
		)
		logger.debug(
			`[CacheInvalidation] Publishing ${action} for ${did}/${rkey} to ${DEFAULT_CACHE_INVALIDATION_CHANNEL} (stream ${streamId})`,
		)
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
export type SiteRevalidationEnqueueResult = 'enqueued' | 'deduplicated' | 'quarantined' | 'capacity' | 'unavailable'

export interface RevalidationQueueClient {
	/** Runs the revalidation enqueue script atomically. */
	eval(script: string, keyCount: number, ...args: string[]): PromiseLike<unknown>
}

// This script deliberately has no MAXLEN. A producer must never remove a
// pending consumer-group entry. Capacity is a hard backpressure boundary; ACK
// plus XDEL is the only normal removal path.
const ENQUEUE_REVALIDATION_SCRIPT = `
if ARGV[7] == '1' then
  local quarantine = redis.call('GET', KEYS[3])
  if quarantine and (ARGV[8] == '' or ARGV[8] <= quarantine) then return {-2, quarantine} end
end

local existing = redis.call('GET', KEYS[1])
if existing then
  local found = redis.call('XRANGE', KEYS[2], existing, existing, 'COUNT', 1)
  if #found == 1 and found[1][1] == existing then return {0, existing} end
  redis.call('DEL', KEYS[1])
end
if redis.call('XLEN', KEYS[2]) >= tonumber(ARGV[1]) then return {-1, ''} end
local id = redis.call('XADD', KEYS[2], '*', 'did', ARGV[2], 'rkey', ARGV[3], 'reason', ARGV[4], 'ts', ARGV[5], 'sourceVersion', ARGV[8])
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
	sourceVersion = '',
): Promise<SiteRevalidationEnqueueResult> {
	const dedupeCategory = getRevalidationDedupeCategory(reason)
	const dedupeKey = `revalidate:site:${dedupeCategory}:${did}:${rkey}`
	try {
		const outcome = parseEnqueueResult(
			await redis.eval(
				ENQUEUE_REVALIDATION_SCRIPT,
				3,
				dedupeKey,
				config.revalidateStream,
				revalidationQuarantineKey(did, rkey),
				config.revalidateStreamMaxLen.toString(),
				did,
				rkey,
				reason,
				Date.now().toString(),
				config.revalidateDedupeTtlSeconds.toString(),
				dedupeCategory === 'settings' ? '0' : '1',
				sourceVersion,
			),
		)
		if (!outcome) {
			logger.error('[Revalidate] Redis enqueue script returned an invalid result', undefined, { did, rkey, reason })
			return 'unavailable'
		}
		if (outcome.status === 0 && outcome.streamId) return 'deduplicated'
		if (outcome.status === -2 && outcome.streamId) return 'quarantined'
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
	sourceVersion = '',
): Promise<SiteRevalidationEnqueueResult> {
	const redis = getPublisher()
	if (!redis) return 'unavailable'
	return enqueueSiteRevalidationWithRedis(redis, did, rkey, reason, sourceVersion)
}

/**
 * Record a successfully reconciled repo revision and clear only an older DLQ
 * fence. ATProto repo revisions are monotonic TIDs, so relay replays of the
 * same or an older event cannot reopen hosting repair work.
 */
export async function recordSiteReconciliation(did: string, rkey: string, revision: string): Promise<boolean> {
	if (!config.redisUrl) return true
	const redis = getPublisher()
	if (!redis || !/^[a-z2-7]{13}$/.test(revision)) return false
	try {
		await waitForCacheInvalidationPublisherReady(redis, publisherReadyTimeoutMs)
		const result = await redis.eval(
			`local current = redis.call('GET', KEYS[1])
if current and current >= ARGV[1] then return {0, current, 0} end
redis.call('SET', KEYS[1], ARGV[1])
local quarantine = redis.call('GET', KEYS[2])
if quarantine and ARGV[1] > quarantine then
  redis.call('DEL', KEYS[2])
  return {1, ARGV[1], 1}
end
return {1, ARGV[1], 0}`,
			2,
			revalidationSiteVersionKey(did, rkey),
			revalidationQuarantineKey(did, rkey),
			revision,
		)
		return Array.isArray(result) && (result[0] === 0 || result[0] === 1)
	} catch (error) {
		logger.error('[Revalidate] Failed to record successful site reconciliation', undefined, {
			did,
			rkey,
			errorKind: revalidationErrorKind(error),
		})
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
