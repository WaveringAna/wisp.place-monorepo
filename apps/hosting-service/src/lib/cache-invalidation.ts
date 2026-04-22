/**
 * Cache invalidation subscriber
 *
 * Uses Redis pub/sub for low-latency invalidation and a Redis stream for replay.
 * When a site is updated/deleted, clears the hosting-service's local caches
 * (tiered storage hot+warm tiers, redirect rules) so stale data isn't served.
 *
 * Also tracks sites that are actively being downloaded ('updating' action) so
 * the serving layer can show a "site updating" page instead of stale/partial content.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { StorageTier } from '@wispplace/tiered-storage'
import Redis from 'ioredis'
import { cache } from './cache-manager'
import { hotTier, warmTier } from './storage'

const CHANNEL = 'wisp:cache-invalidate'
const STREAM = process.env.WISP_CACHE_INVALIDATION_STREAM || 'wisp:cache-invalidate-stream'
const STREAM_BLOCK_MS = parsePositiveInt(process.env.WISP_CACHE_INVALIDATION_BLOCK_MS, 5000)
const STREAM_BATCH_COUNT = parsePositiveInt(process.env.WISP_CACHE_INVALIDATION_BATCH_COUNT, 100)
const CURSOR_FILE =
	process.env.WISP_CACHE_INVALIDATION_CURSOR_FILE ||
	resolve(process.env.CACHE_DIR || './cache/sites', '..', 'cache-invalidation.lastid')
const STREAM_ID_PATTERN = /^\d+-\d+$/

type CacheInvalidationAction = 'updating' | 'update' | 'delete' | 'settings'

export interface CacheInvalidationMessage {
	did: string
	rkey: string
	action: CacheInvalidationAction
	token?: string
	streamId?: string
}

// Sites currently being downloaded by the firehose-service.
// Maps `${did}/${rkey}` → current update token and timestamp.
// Used to show an "updating" page instead of serving stale files.
const UPDATING_TTL_MS = 10 * 60 * 1000 // 10 minutes safety timeout
const updatingSites = new Map<string, { since: number; token?: string }>()

export function isSiteUpdating(did: string, rkey: string): boolean {
	const key = `${did}/${rkey}`
	const state = updatingSites.get(key)
	if (state === undefined) return false
	if (Date.now() - state.since > UPDATING_TTL_MS) {
		// Firehose must have crashed; remove the stale entry
		updatingSites.delete(key)
		return false
	}
	return true
}

export function markSiteUpdating(did: string, rkey: string, token?: string): void {
	updatingSites.set(`${did}/${rkey}`, { since: Date.now(), token })
}

export function clearSiteUpdating(did: string, rkey: string, token?: string): boolean {
	const key = `${did}/${rkey}`
	const state = updatingSites.get(key)
	if (!state) return false

	// Unversioned clears are treated as unconditional for compatibility.
	// Versioned clears only succeed if they match the active update token.
	if (token && state.token && state.token !== token) {
		return false
	}

	updatingSites.delete(key)
	return true
}

export function resetUpdatingSitesForTests(): void {
	updatingSites.clear()
}

let subscriber: Redis | null = null
let replayClient: Redis | null = null
let stopReplayRequested = false
let replayLoop: Promise<void> | null = null
let processingQueue: Promise<void> = Promise.resolve()
let cursorPersistQueue: Promise<void> = Promise.resolve()
let lastProcessedStreamId = '0-0'

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeStreamId(streamId: string | undefined): string | undefined {
	if (!streamId) return undefined
	const trimmed = streamId.trim()
	return STREAM_ID_PATTERN.test(trimmed) ? trimmed : undefined
}

function parseStreamIdParts(streamId: string): [bigint, bigint] {
	const normalized = normalizeStreamId(streamId)
	if (!normalized) {
		throw new Error(`Invalid Redis stream id: ${streamId}`)
	}

	const [msRaw, seqRaw] = normalized.split('-') as [string, string]
	return [BigInt(msRaw), BigInt(seqRaw)]
}

export function compareStreamIds(a: string, b: string): number {
	const [aMs, aSeq] = parseStreamIdParts(a)
	const [bMs, bSeq] = parseStreamIdParts(b)
	if (aMs < bMs) return -1
	if (aMs > bMs) return 1
	if (aSeq < bSeq) return -1
	if (aSeq > bSeq) return 1
	return 0
}

function loadCursorFromDisk(): void {
	if (!existsSync(CURSOR_FILE)) return

	try {
		const stored = normalizeStreamId(readFileSync(CURSOR_FILE, 'utf8'))
		if (!stored) {
			console.warn(`[CacheInvalidation] Ignoring invalid cursor file contents in ${CURSOR_FILE}`)
			return
		}
		lastProcessedStreamId = stored
		console.log(`[CacheInvalidation] Loaded replay cursor ${stored} from ${CURSOR_FILE}`)
	} catch (err) {
		console.error(`[CacheInvalidation] Failed to load cursor file ${CURSOR_FILE}:`, err)
	}
}

function queueCursorPersist(streamId: string): void {
	cursorPersistQueue = cursorPersistQueue
		.catch(() => undefined)
		.then(async () => {
			const dir = dirname(CURSOR_FILE)
			const tmp = `${CURSOR_FILE}.tmp`
			await mkdir(dir, { recursive: true })
			await writeFile(tmp, `${streamId}\n`, 'utf8')
			await rename(tmp, CURSOR_FILE)
		})
		.catch((err) => {
			console.error(`[CacheInvalidation] Failed to persist cursor ${streamId} to ${CURSOR_FILE}:`, err)
		})
}

function advanceStreamCursor(streamId: string | undefined): void {
	const normalized = normalizeStreamId(streamId)
	if (!normalized) return
	if (compareStreamIds(normalized, lastProcessedStreamId) <= 0) return
	lastProcessedStreamId = normalized
	queueCursorPersist(normalized)
}

function shouldSkipReplayMessage(streamId: string | undefined): boolean {
	const normalized = normalizeStreamId(streamId)
	if (!normalized) return false
	return compareStreamIds(normalized, lastProcessedStreamId) <= 0
}

export function parseCacheInvalidationMessage(message: string): CacheInvalidationMessage | null {
	let parsed: Partial<CacheInvalidationMessage>
	try {
		parsed = JSON.parse(message) as Partial<CacheInvalidationMessage>
	} catch {
		return null
	}

	if (
		typeof parsed.did !== 'string' ||
		typeof parsed.rkey !== 'string' ||
		(parsed.action !== 'updating' &&
			parsed.action !== 'update' &&
			parsed.action !== 'delete' &&
			parsed.action !== 'settings')
	) {
		return null
	}

	return {
		did: parsed.did,
		rkey: parsed.rkey,
		action: parsed.action,
		token: typeof parsed.token === 'string' ? parsed.token : undefined,
		streamId: normalizeStreamId(parsed.streamId),
	}
}

export function parseCacheInvalidationStreamEntry(streamId: string, fields: string[]): CacheInvalidationMessage | null {
	const payload: Record<string, string> = {}

	for (let index = 0; index < fields.length - 1; index += 2) {
		payload[fields[index]!] = fields[index + 1]!
	}

	const parsed = parseCacheInvalidationMessage(
		JSON.stringify({
			did: payload.did,
			rkey: payload.rkey,
			action: payload.action,
			token: payload.token,
			streamId,
		}),
	)
	return parsed
}

/**
 * Directly invalidate a tier by listing and deleting all keys with the given prefix.
 * Each tier is invalidated independently so a failure in one doesn't block the others.
 */
async function invalidateTier(tier: StorageTier, tierName: string, prefix: string): Promise<number> {
	try {
		const keys: string[] = []
		for await (const key of tier.listKeys(prefix)) {
			keys.push(key)
		}
		if (keys.length > 0) {
			await tier.deleteMany(keys)
		}
		return keys.length
	} catch (err) {
		console.error(`[CacheInvalidation] Failed to invalidate ${tierName} tier for prefix ${prefix}:`, err)
		return 0
	}
}

async function applyCacheInvalidation(parsed: CacheInvalidationMessage, source: 'pubsub' | 'replay'): Promise<void> {
	const { did, rkey, action, token, streamId } = parsed

	if (shouldSkipReplayMessage(streamId)) {
		console.log(
			`[CacheInvalidation] Skipping duplicate ${action} for ${did}/${rkey} from ${source} (stream ${streamId})`,
		)
		return
	}

	console.log(
		`[CacheInvalidation] Received ${action} for ${did}/${rkey} from ${source}${streamId ? ` (stream ${streamId})` : ''}`,
	)

	if (action === 'updating') {
		markSiteUpdating(did, rkey, token)
		advanceStreamCursor(streamId)
		console.log(`[CacheInvalidation] Marked ${did}/${rkey} as updating`)
		return
	}

	const cleared = clearSiteUpdating(did, rkey, token)
	if (!cleared && action === 'update' && token) {
		console.log(`[CacheInvalidation] Ignored stale update clear for ${did}/${rkey}`)
		advanceStreamCursor(streamId)
		return
	}

	const prefix = `${did}/${rkey}/`
	const hotDeleted = await invalidateTier(hotTier, 'hot', prefix)
	const warmDeleted = warmTier ? await invalidateTier(warmTier, 'warm', prefix) : 0

	console.log(`[CacheInvalidation] Cleared ${hotDeleted} hot + ${warmDeleted} warm keys for ${did}/${rkey}`)

	cache.delete('redirectRules', `${did}:${rkey}`)
	cache.delete('settings', `${did}:${rkey}`)
	cache.deletePrefix('siteFiles', `${did}:${rkey}:`)
	advanceStreamCursor(streamId)
}

function enqueueCacheInvalidation(parsed: CacheInvalidationMessage, source: 'pubsub' | 'replay'): Promise<void> {
	processingQueue = processingQueue
		.then(() => applyCacheInvalidation(parsed, source))
		.catch((err) => {
			console.error('[CacheInvalidation] Error processing message:', err)
		})
	return processingQueue
}

function ensureReplayLoopStarted(): void {
	if (!replayClient || replayLoop || stopReplayRequested) return

	replayLoop = (async () => {
		console.log(`[CacheInvalidation] Starting replay loop on ${STREAM} from ${lastProcessedStreamId}`)

		while (!stopReplayRequested) {
			try {
				const response = await replayClient.xread(
					'COUNT',
					STREAM_BATCH_COUNT,
					'BLOCK',
					STREAM_BLOCK_MS,
					'STREAMS',
					STREAM,
					lastProcessedStreamId,
				)

				if (!response) continue

				for (const [, entries] of response as [string, Array<[string, string[]]>][]) {
					for (const [streamId, fields] of entries) {
						const parsed = parseCacheInvalidationStreamEntry(streamId, fields)
						if (!parsed) {
							console.warn(`[CacheInvalidation] Invalid stream entry ${streamId} on ${STREAM}`)
							advanceStreamCursor(streamId)
							continue
						}

						await enqueueCacheInvalidation(parsed, 'replay')
					}
				}
			} catch (err) {
				if (stopReplayRequested) break
				console.error('[CacheInvalidation] Replay loop error:', err)
				await new Promise((resolve) => setTimeout(resolve, 1000))
			}
		}
	})()
		.catch((err) => {
			if (!stopReplayRequested) {
				console.error('[CacheInvalidation] Replay loop crashed:', err)
			}
		})
		.finally(() => {
			replayLoop = null
		})
}

export function startCacheInvalidationSubscriber(): void {
	const redisUrl = process.env.REDIS_URL
	if (!redisUrl) {
		console.warn('[CacheInvalidation] REDIS_URL not set; cache invalidation disabled')
		return
	}

	loadCursorFromDisk()
	stopReplayRequested = false

	console.log(`[CacheInvalidation] Connecting to Redis for subscribing: ${redisUrl}`)
	subscriber = new Redis(redisUrl, {
		maxRetriesPerRequest: 2,
		enableReadyCheck: true,
	})
	replayClient = new Redis(redisUrl, {
		maxRetriesPerRequest: 2,
		enableReadyCheck: true,
	})

	subscriber.on('error', (err) => {
		console.error('[CacheInvalidation] Redis error:', err)
	})
	replayClient.on('error', (err) => {
		console.error('[CacheInvalidation] Replay Redis error:', err)
	})

	subscriber.on('ready', () => {
		console.log('[CacheInvalidation] Redis subscriber connected')
	})
	replayClient.on('ready', () => {
		console.log('[CacheInvalidation] Redis replay client connected')
		ensureReplayLoopStarted()
	})

	subscriber.subscribe(CHANNEL, (err) => {
		if (err) {
			console.error('[CacheInvalidation] Failed to subscribe:', err)
		} else {
			console.log('[CacheInvalidation] Subscribed to', CHANNEL)
		}
	})

	subscriber.on('message', async (_channel: string, message: string) => {
		const parsed = parseCacheInvalidationMessage(message)
		if (!parsed) {
			console.warn('[CacheInvalidation] Invalid message:', message)
			return
		}

		await enqueueCacheInvalidation(parsed, 'pubsub')
	})

	ensureReplayLoopStarted()
}

export async function stopCacheInvalidationSubscriber(): Promise<void> {
	stopReplayRequested = true
	await replayLoop
	await processingQueue
	await cursorPersistQueue.catch(() => undefined)

	if (subscriber) {
		const toClose = subscriber
		subscriber = null
		await toClose.quit()
	}

	if (replayClient) {
		const toClose = replayClient
		replayClient = null
		await toClose.quit()
	}
}
