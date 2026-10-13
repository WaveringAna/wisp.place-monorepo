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

const MAX_REVALIDATE_STREAM_CAPACITY = DEFAULT_REVALIDATE_STREAM_CAPACITY
const MAX_REVALIDATE_DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60

export type RevalidateQueueConfig = {
	redisUrl: string | undefined
	streamName: string
	streamMaxLen: number
	dedupeTtlSeconds: number
	storageMissDedupeTtlSeconds: number
}

function parseBoundedPositiveInt(value: string | undefined, fallback: number, maximum: number): number {
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback
}

export function resolveRevalidateQueueConfig(env: NodeJS.ProcessEnv = process.env): RevalidateQueueConfig {
	const dedupeTtlSeconds = parseBoundedPositiveInt(
		env.WISP_REVALIDATE_DEDUPE_TTL_SECONDS,
		60,
		MAX_REVALIDATE_DEDUPE_TTL_SECONDS,
	)
	return {
		redisUrl: env.REDIS_URL,
		streamName: env.WISP_REVALIDATE_STREAM || DEFAULT_REVALIDATE_STREAM,
		streamMaxLen: parseBoundedPositiveInt(env.WISP_REVALIDATE_STREAM_MAXLEN, 10_000, MAX_REVALIDATE_STREAM_CAPACITY),
		dedupeTtlSeconds,
		storageMissDedupeTtlSeconds: parseBoundedPositiveInt(
			env.WISP_REVALIDATE_STORAGE_MISS_DEDUPE_TTL_SECONDS,
			Math.max(dedupeTtlSeconds, 600),
			MAX_REVALIDATE_DEDUPE_TTL_SECONDS,
		),
	}
}

const defaultConfig = resolveRevalidateQueueConfig()

function redisErrorKind(error: unknown): string {
	if (error instanceof Error && error.name) return error.name
	return 'UnknownError'
}

function getDedupeTtlSeconds(config: RevalidateQueueConfig, reasonCategory: RevalidateReasonCategory): number {
	if (reasonCategory === 'storage-miss') {
		return config.storageMissDedupeTtlSeconds
	}
	return config.dedupeTtlSeconds
}

export type EnqueueResult = 'enqueued' | 'deduped' | 'quarantined' | 'disabled' | 'error'

export async function enqueueRevalidateWithRedis(
	redis: RevalidateQueueClient,
	did: string,
	rkey: string,
	reason: string,
	config: RevalidateQueueConfig = defaultConfig,
): Promise<{ enqueued: boolean; result: Exclude<EnqueueResult, 'disabled'> }> {
	const { streamName } = config
	try {
		const outcome = await enqueueSiteRevalidation(redis, {
			stream: streamName,
			maxLen: config.streamMaxLen,
			dedupeTtlSeconds: getDedupeTtlSeconds(config, revalidateReasonCategory(reason)),
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

/** The slice of an ioredis connection the queue uses. */
export interface RevalidateRedisConnection extends RevalidateQueueClient {
	readonly status: string
	on(event: 'error' | 'ready', listener: (...args: unknown[]) => void): unknown
	ping(): Promise<unknown>
	quit(): Promise<unknown>
}

export type RevalidateQueueDeps = {
	config: RevalidateQueueConfig
	connect: (redisUrl: string) => RevalidateRedisConnection
}

/** One lazily connected revalidation queue; nothing connects until the first enqueue. */
export function createRevalidateQueue({ config, connect }: RevalidateQueueDeps) {
	let client: RevalidateRedisConnection | null = null
	let stopKeepalive: (() => void) | null = null
	let loggedMissingRedis = false

	function getRedisClient(): RevalidateRedisConnection | null {
		if (!config.redisUrl) {
			if (!loggedMissingRedis) {
				console.warn('[Revalidate] REDIS_URL not set; skipping queue enqueue')
				loggedMissingRedis = true
			}
			return null
		}

		if (!client) {
			console.log('[Revalidate] Connecting to Redis')
			const created = connect(config.redisUrl)
			client = created

			created.on('error', (err) => {
				console.error(`[Revalidate] Redis error (${redisErrorKind(err)})`)
			})

			created.on('ready', () => {
				console.log(`[Revalidate] Redis connected, stream: ${config.streamName}`)
			})

			// Enqueues are rare, so without a ping haproxy cuts the idle connection every 180 s.
			stopKeepalive = startRedisKeepalive(() => (created.status === 'ready' ? created.ping() : undefined), {
				onError: (err) => console.warn(`[Revalidate] Redis keepalive failed (${redisErrorKind(err)})`),
			})
		}

		return client
	}

	async function enqueueRevalidate(
		did: string,
		rkey: string,
		reason: string,
	): Promise<{ enqueued: boolean; result: EnqueueResult }> {
		const redis = getRedisClient()
		if (!redis) {
			recordRevalidateResult('disabled')
			return { enqueued: false, result: 'disabled' }
		}

		return await enqueueRevalidateWithRedis(redis, did, rkey, reason, config)
	}

	async function closeRevalidateQueue(): Promise<void> {
		if (client) {
			const toClose = client
			client = null
			stopKeepalive?.()
			stopKeepalive = null
			await toClose.quit()
		}
	}

	return { enqueueRevalidate, closeRevalidateQueue }
}

export const { enqueueRevalidate, closeRevalidateQueue } = createRevalidateQueue({
	config: defaultConfig,
	connect: (redisUrl) =>
		new Redis(redisUrl, {
			maxRetriesPerRequest: 2,
			enableReadyCheck: true,
		}),
})
