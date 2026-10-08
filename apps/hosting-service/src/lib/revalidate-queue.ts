import {
	DEFAULT_REVALIDATE_STREAM,
	DEFAULT_REVALIDATE_STREAM_CAPACITY,
	enqueueSiteRevalidation,
	type RevalidateQueueClient,
	type RevalidateReasonCategory,
	revalidateReasonCategory,
	startRedisKeepalive,
} from '@wispplace/constants'
import Redis from 'ioredis'
import { recordRevalidateResult } from './revalidate-metrics'

const redisUrl = process.env.REDIS_URL
const streamName = process.env.WISP_REVALIDATE_STREAM || DEFAULT_REVALIDATE_STREAM
const MAX_REVALIDATE_STREAM_CAPACITY = DEFAULT_REVALIDATE_STREAM_CAPACITY
const MAX_REVALIDATE_DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60
const streamMaxLen = parseBoundedPositiveInt(
	process.env.WISP_REVALIDATE_STREAM_MAXLEN,
	10_000,
	MAX_REVALIDATE_STREAM_CAPACITY,
)
const dedupeTtlSeconds = parseBoundedPositiveInt(
	process.env.WISP_REVALIDATE_DEDUPE_TTL_SECONDS,
	60,
	MAX_REVALIDATE_DEDUPE_TTL_SECONDS,
)
const storageMissDedupeTtlSeconds = parseBoundedPositiveInt(
	process.env.WISP_REVALIDATE_STORAGE_MISS_DEDUPE_TTL_SECONDS,
	Math.max(dedupeTtlSeconds, 600),
	MAX_REVALIDATE_DEDUPE_TTL_SECONDS,
)

let client: Redis | null = null
let stopKeepalive: (() => void) | null = null
let loggedMissingRedis = false

function parseBoundedPositiveInt(value: string | undefined, fallback: number, maximum: number): number {
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback
}

function redisErrorKind(error: unknown): string {
	if (error instanceof Error && error.name) return error.name
	return 'UnknownError'
}

function getDedupeTtlSeconds(reasonCategory: RevalidateReasonCategory): number {
	if (reasonCategory === 'storage-miss') {
		return storageMissDedupeTtlSeconds
	}
	return dedupeTtlSeconds
}

function getRedisClient(): Redis | null {
	if (!redisUrl) {
		if (!loggedMissingRedis) {
			console.warn('[Revalidate] REDIS_URL not set; skipping queue enqueue')
			loggedMissingRedis = true
		}
		return null
	}

	if (!client) {
		console.log('[Revalidate] Connecting to Redis')
		client = new Redis(redisUrl, {
			maxRetriesPerRequest: 2,
			enableReadyCheck: true,
		})

		client.on('error', (err) => {
			console.error(`[Revalidate] Redis error (${redisErrorKind(err)})`)
		})

		client.on('ready', () => {
			console.log(`[Revalidate] Redis connected, stream: ${streamName}`)
		})

		// Enqueues are rare, so without a ping haproxy cuts the idle connection every 180 s.
		const created = client
		stopKeepalive = startRedisKeepalive(() => (created.status === 'ready' ? created.ping() : undefined), {
			onError: (err) => console.warn(`[Revalidate] Redis keepalive failed (${redisErrorKind(err)})`),
		})
	}

	return client
}

export type EnqueueResult = 'enqueued' | 'deduped' | 'quarantined' | 'disabled' | 'error'

export async function enqueueRevalidateWithRedis(
	redis: RevalidateQueueClient,
	did: string,
	rkey: string,
	reason: string,
): Promise<{ enqueued: boolean; result: Exclude<EnqueueResult, 'disabled'> }> {
	try {
		const outcome = await enqueueSiteRevalidation(redis, {
			stream: streamName,
			maxLen: streamMaxLen,
			dedupeTtlSeconds: getDedupeTtlSeconds(revalidateReasonCategory(reason)),
			did,
			rkey,
			reason,
		})
		if (outcome === 'full') {
			console.warn(`[Revalidate] Queue capacity reached for ${did}/${rkey}`)
			recordRevalidateResult('error')
			return { enqueued: false, result: 'error' }
		}
		recordRevalidateResult(outcome)
		if (outcome === 'enqueued') console.log(`[Revalidate] Enqueued ${did}/${rkey} (${reason}) to ${streamName}`)
		return { enqueued: outcome === 'enqueued', result: outcome }
	} catch (err) {
		recordRevalidateResult('error')
		console.error('[Revalidate] Failed to enqueue', { did, rkey, reason, errorKind: redisErrorKind(err) })
		return { enqueued: false, result: 'error' }
	}
}

export async function enqueueRevalidate(
	did: string,
	rkey: string,
	reason: string,
): Promise<{ enqueued: boolean; result: EnqueueResult }> {
	const redis = getRedisClient()
	if (!redis) {
		recordRevalidateResult('disabled')
		return { enqueued: false, result: 'disabled' }
	}

	return await enqueueRevalidateWithRedis(redis, did, rkey, reason)
}

export async function closeRevalidateQueue(): Promise<void> {
	if (client) {
		const toClose = client
		client = null
		stopKeepalive?.()
		stopKeepalive = null
		await toClose.quit()
	}
}
