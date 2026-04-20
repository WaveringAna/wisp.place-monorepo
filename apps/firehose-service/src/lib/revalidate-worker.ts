import os from 'node:os'
import { createLogger } from '@wispplace/observability'
import Redis from 'ioredis'
import { config } from '../config'
import { fetchSiteRecord, handleSiteCreateOrUpdate, SiteBlobBackoffError } from './cache-writer'

const logger = createLogger('firehose-service')
const consumerName = process.env.WISP_REVALIDATE_CONSUMER || `${os.hostname()}:${process.pid}`
const batchSize = Number.parseInt(process.env.WISP_REVALIDATE_BATCH_SIZE || '10', 10)
const claimIdleMs = Number.parseInt(process.env.WISP_REVALIDATE_CLAIM_IDLE_MS || '60000', 10)
const blockMs = Number.parseInt(process.env.WISP_REVALIDATE_BLOCK_MS || '5000', 10)
const failureBackoffSeconds = parsePositiveInt(process.env.WISP_REVALIDATE_FAILURE_BACKOFF_SECONDS, 600)

let redis: Redis | null = null
let running = false
let loopPromise: Promise<void> | null = null

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getFailureBackoffKey(did: string, rkey: string): string {
	return `revalidate:site:failure-backoff:${did}:${rkey}`
}

function parseFields(raw: string[]): Record<string, string> {
	const fields: Record<string, string> = {}
	for (let i = 0; i < raw.length; i += 2) {
		const key = raw[i]
		const value = raw[i + 1]
		if (key) {
			fields[key] = value ?? ''
		}
	}
	return fields
}

export function shouldSkipInvalidationForReason(reason: string): boolean {
	// Rewrite repairs only repopulate `.rewritten/*` HTML variants. They should not
	// flip the whole site into "updating" while the original files remain serveable.
	return reason.startsWith('rewrite-miss')
}

async function processMessage(id: string, rawFields: string[]): Promise<void> {
	if (!redis) return

	const fields = parseFields(rawFields)
	const did = fields.did
	const rkey = fields.rkey
	const reason = fields.reason || 'storage-miss'

	if (!did || !rkey) {
		logger.warn('[Revalidate] Missing did/rkey in message', { id, fields })
		await redis.xack(config.revalidateStream, config.revalidateGroup, id)
		return
	}

	logger.info(`[Revalidate] Received message ${id}: ${did}/${rkey} (${reason})`)

	const failureBackoffKey = getFailureBackoffKey(did, rkey)
	const activeBackoffTtl = await redis.ttl(failureBackoffKey)
	if (activeBackoffTtl > 0) {
		logger.info(`[Revalidate] Acking ${id}: ${did}/${rkey} site backoff active (${activeBackoffTtl}s remaining)`)
		await redis.xack(config.revalidateStream, config.revalidateGroup, id)
		return
	}

	const record = await fetchSiteRecord(did, rkey)
	if (!record) {
		logger.warn(`[Revalidate] Site record not found on PDS: ${did}/${rkey}`)
		await redis.xack(config.revalidateStream, config.revalidateGroup, id)
		return
	}

	// For storage-miss events, force re-download all files since storage is empty
	const forceDownload = reason.startsWith('storage-miss')
	const forceRewriteHtml = reason.startsWith('rewrite-miss')
	const skipInvalidation = shouldSkipInvalidationForReason(reason)

	try {
		await handleSiteCreateOrUpdate(did, rkey, record.record, record.cid, {
			skipInvalidation,
			forceDownload,
			forceRewriteHtml,
		})
	} catch (err) {
		if (err instanceof SiteBlobBackoffError) {
			const now = Date.now()
			const until = Math.max(err.until, now + 1000)
			const ttlSeconds = Math.max(failureBackoffSeconds, Math.ceil((until - now) / 1000))
			await redis.set(failureBackoffKey, until.toString(), 'EX', ttlSeconds)
			logger.warn(`[Revalidate] Blob backoff for ${did}/${rkey}; acking ${id} and suppressing retries`, {
				did,
				rkey,
				failures: err.failures,
				backoffUntil: new Date(until).toISOString(),
				ttlSeconds,
			})
			await redis.xack(config.revalidateStream, config.revalidateGroup, id)
			return
		}
		throw err
	}

	logger.info(`[Revalidate] Completed ${id}: ${did}/${rkey}`)
	await redis.xack(config.revalidateStream, config.revalidateGroup, id)
}

async function processMessages(messages: Array<[string, string[]]>): Promise<void> {
	for (const [id, rawFields] of messages) {
		try {
			await processMessage(id, rawFields)
		} catch (err) {
			logger.error('[Revalidate] Failed to process message', err, { id })
		}
	}
}

async function ensureGroup(): Promise<void> {
	if (!redis) return
	try {
		await redis.xgroup('CREATE', config.revalidateStream, config.revalidateGroup, '0', 'MKSTREAM')
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err))
		if (!error.message.includes('BUSYGROUP')) {
			throw error
		}
	}
}

async function claimStaleMessages(): Promise<void> {
	if (!redis) return

	let startId = '0-0'

	while (running) {
		const response = (await redis.xautoclaim(
			config.revalidateStream,
			config.revalidateGroup,
			consumerName,
			claimIdleMs,
			startId,
			'COUNT',
			batchSize,
		)) as unknown as [string, Array<[string, string[]]>]

		const nextId = response[0]
		const messages = response[1] || []

		if (messages.length === 0) {
			break
		}

		await processMessages(messages)

		if (nextId === startId) {
			break
		}
		startId = nextId
	}
}

async function readNewMessages(): Promise<void> {
	if (!redis) return

	const response = (await redis.xreadgroup(
		'GROUP',
		config.revalidateGroup,
		consumerName,
		'COUNT',
		batchSize,
		'BLOCK',
		blockMs,
		'STREAMS',
		config.revalidateStream,
		'>',
	)) as [string, Array<[string, string[]]>][] | null

	if (!response) return

	for (const [, messages] of response) {
		await processMessages(messages)
	}
}

async function runLoop(): Promise<void> {
	if (!redis) return

	await ensureGroup()

	while (running) {
		try {
			await claimStaleMessages()
			await readNewMessages()
		} catch (err) {
			logger.error('[Revalidate] Loop error', err)
			await new Promise((resolve) => setTimeout(resolve, 1000))
		}
	}
}

export async function startRevalidateWorker(): Promise<void> {
	if (!config.redisUrl) {
		logger.warn('[Revalidate] REDIS_URL not set; revalidate worker disabled')
		return
	}

	if (running) return

	logger.info(`[Revalidate] Connecting to Redis: ${config.redisUrl}`)
	redis = new Redis(config.redisUrl, {
		maxRetriesPerRequest: 2,
		enableReadyCheck: true,
	})

	redis.on('error', (err) => {
		logger.error('[Revalidate] Redis error', err)
	})

	redis.on('ready', () => {
		logger.info(`[Revalidate] Redis connected, stream: ${config.revalidateStream}, group: ${config.revalidateGroup}`)
	})

	running = true
	loopPromise = runLoop()
}

export async function stopRevalidateWorker(): Promise<void> {
	running = false
	await loopPromise
	loopPromise = null

	if (redis) {
		const toClose = redis
		redis = null
		await toClose.quit()
	}
}
