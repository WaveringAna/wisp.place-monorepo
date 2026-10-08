/**
 * Canonical revalidation stream names shared by every producer and consumer.
 *
 * The work stream and its dead-letter stream are deliberately separate: the
 * DLQ is a quarantine fence with a different schema (sourceId, errorCode,
 * classification, attempts) and a manual replay lifecycle, so it must never be
 * folded into the live work stream. Emergency or paused copies of the work
 * stream are operational duplicates; this module is the single source of truth
 * for the canonical names so producers and consumers cannot drift apart.
 */
export const DEFAULT_REVALIDATE_STREAM = 'wisp:revalidate'
export const DEFAULT_REVALIDATE_STREAM_CAPACITY = 1_000_000
export const DEFAULT_REVALIDATE_DLQ_STREAM = 'wisp:revalidate:dlq'

/** Prefix of every per-site quarantine fence key; the rest is `<did>/<rkey>`, each URI-encoded. */
export const REVALIDATE_QUARANTINE_KEY_PREFIX = 'wisp:revalidate:quarantine:'

/**
 * Durable per-site fence installed when repair work reaches the DLQ.
 *
 * Hosting producers must not recreate work behind this fence. Only a newer
 * firehose event, or a verified repair whose source blobs were all fetched
 * first (operator command or the firehose retry schedule), may clear it.
 */
export function revalidationQuarantineKey(did: string, rkey: string): string {
	return `${REVALIDATE_QUARANTINE_KEY_PREFIX}${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`
}

/** Latest successfully reconciled ATProto repo revision for one site. */
export function revalidationSiteVersionKey(did: string, rkey: string): string {
	return `wisp:revalidate:version:${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`
}

export type RevalidateReasonCategory = 'storage-miss' | 'rewrite-miss' | 'other'

/** Dedupe keys are per category so a storage-miss is never silenced by a pending rewrite-miss. */
export function revalidateReasonCategory(reason: string): RevalidateReasonCategory {
	if (reason.startsWith('storage-miss')) return 'storage-miss'
	if (reason.startsWith('rewrite-miss')) return 'rewrite-miss'
	return 'other'
}

/** The one call an enqueuer needs; ioredis and Bun's RedisClient both adapt to it. */
export interface RevalidateQueueClient {
	eval(script: string, keyCount: number, ...keysAndArgs: string[]): PromiseLike<unknown>
}

// Dedupe and enqueue are one atomic operation. The key stores the exact stream
// ID and is trusted only while XRANGE proves that entry still exists. Producers
// never MAXLEN-trim because that can remove pending consumer-group work.
export const REVALIDATE_ENQUEUE_SCRIPT = `
local quarantine = redis.call('GET', KEYS[3])
if quarantine then return {-2, quarantine} end
local sourceVersion = redis.call('GET', KEYS[4]) or ''

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

export interface RevalidateRequest {
	stream: string
	maxLen: number
	dedupeTtlSeconds: number
	did: string
	rkey: string
	reason: string
}

/** `full` means the stream is at capacity; nothing was added. */
export type RevalidateEnqueueOutcome = 'enqueued' | 'deduped' | 'quarantined' | 'full'

/** Atomically enqueue one site for the firehose revalidation worker. Throws on Redis or protocol errors. */
export async function enqueueSiteRevalidation(
	redis: RevalidateQueueClient,
	{ stream, maxLen, dedupeTtlSeconds, did, rkey, reason }: RevalidateRequest,
): Promise<RevalidateEnqueueOutcome> {
	const reply = await redis.eval(
		REVALIDATE_ENQUEUE_SCRIPT,
		4,
		`revalidate:site:${revalidateReasonCategory(reason)}:${did}:${rkey}`,
		stream,
		revalidationQuarantineKey(did, rkey),
		revalidationSiteVersionKey(did, rkey),
		dedupeTtlSeconds.toString(),
		maxLen.toString(),
		did,
		rkey,
		reason,
		Date.now().toString(),
	)
	if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'string') {
		throw new Error('Unexpected Redis revalidate enqueue script response')
	}
	const [status, streamId] = reply as [number, string]
	if (status === 1 && streamId) return 'enqueued'
	if (status === 0 && streamId) return 'deduped'
	if (status === -2) return 'quarantined'
	if (status === -1) return 'full'
	throw new Error('Unexpected Redis revalidate enqueue script status')
}
