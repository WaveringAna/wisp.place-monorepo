import { DEFAULT_REVALIDATE_STREAM, DEFAULT_REVALIDATE_STREAM_CAPACITY } from '@wispplace/constants'
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

function getDedupeTtlSeconds(reasonCategory: 'storage-miss' | 'rewrite-miss' | 'other'): number {
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
	}

	return client
}

export type EnqueueResult = 'enqueued' | 'deduped' | 'disabled' | 'error'

type RevalidateReasonCategory = 'storage-miss' | 'rewrite-miss' | 'other'

export interface RevalidateQueueClient {
	eval(script: string, keyCount: number, ...keysAndArgs: string[]): PromiseLike<unknown>
}

// Dedupe and enqueue are one atomic operation. The key stores the exact stream
// ID and is trusted only while XRANGE proves that entry still exists. Producers
// never MAXLEN-trim because that can remove pending consumer-group work.
export const REVALIDATE_ENQUEUE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local found = redis.call('XRANGE', KEYS[2], existing, existing, 'COUNT', 1)
  if #found == 1 and found[1][1] == existing then return {0, existing} end
  redis.call('DEL', KEYS[1])
end

if redis.call('XLEN', KEYS[2]) >= tonumber(ARGV[2]) then return {-1, ''} end
local streamId = redis.pcall('XADD', KEYS[2], '*', 'did', ARGV[3], 'rkey', ARGV[4], 'reason', ARGV[5], 'ts', ARGV[6])
if type(streamId) == 'table' and streamId.err then
  redis.call('DEL', KEYS[1])
  return redis.error_reply(streamId.err)
end
redis.call('SET', KEYS[1], streamId, 'EX', ARGV[1])
return {1, streamId}
`

function getReasonCategory(reason: string): RevalidateReasonCategory {
	if (reason.startsWith('storage-miss')) return 'storage-miss'
	if (reason.startsWith('rewrite-miss')) return 'rewrite-miss'
	return 'other'
}

function parseEnqueueScriptResult(value: unknown): { status: number; streamId: string } | null {
	if (!Array.isArray(value) || typeof value[0] !== 'number' || typeof value[1] !== 'string') return null
	return { status: value[0], streamId: value[1] }
}

export async function enqueueRevalidateWithRedis(
	redis: RevalidateQueueClient,
	did: string,
	rkey: string,
	reason: string,
): Promise<{ enqueued: boolean; result: Exclude<EnqueueResult, 'disabled'> }> {
	// Separate dedup keys per reason category so a storage-miss is never
	// silenced by a pending rewrite-miss (which runs with forceDownload=false).
	const reasonCategory = getReasonCategory(reason)
	const dedupeKey = `revalidate:site:${reasonCategory}:${did}:${rkey}`
	const dedupeTtl = getDedupeTtlSeconds(reasonCategory)

	try {
		const outcome = parseEnqueueScriptResult(
			await redis.eval(
				REVALIDATE_ENQUEUE_SCRIPT,
				2,
				dedupeKey,
				streamName,
				dedupeTtl.toString(),
				streamMaxLen.toString(),
				did,
				rkey,
				reason,
				Date.now().toString(),
			),
		)
		if (!outcome) throw new Error('Unexpected Redis revalidate enqueue script response')
		if (outcome.status === 0 && outcome.streamId) {
			recordRevalidateResult('deduped')
			return { enqueued: false, result: 'deduped' }
		}
		if (outcome.status === -1) {
			console.warn(`[Revalidate] Queue capacity reached for ${did}/${rkey}`)
			recordRevalidateResult('error')
			return { enqueued: false, result: 'error' }
		}
		if (outcome.status !== 1 || !outcome.streamId) {
			throw new Error('Unexpected Redis revalidate enqueue script status')
		}

		console.log(`[Revalidate] Enqueued ${did}/${rkey} (${reason}) to ${streamName}`)
		recordRevalidateResult('enqueued')
		return { enqueued: true, result: 'enqueued' }
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
		await toClose.quit()
	}
}
