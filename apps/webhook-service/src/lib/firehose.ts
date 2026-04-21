import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import { createLogger } from '@wispplace/observability'
import { config } from '../config'
import {
	deleteWebhookRecord,
	findBacklinkWebhooks,
	findWebhooksForDid,
	loadAllWebhooks,
	saveCursor,
	upsertWebhookRecord,
} from './db'
import { deliverWebhook } from './delivery'
import { JetstreamClient, type JetstreamEvent } from './jetstream'
import { matchWebhooks } from './matcher'
import { getCached, invalidate, setCached } from './registry'

const logger = createLogger('webhook-service:firehose')

let lastEventTime = Date.now()
let isConnected = false
let totalEvents = 0
let totalMatched = 0

export function getFirehoseHealth() {
	return {
		connected: isConnected,
		lastEventTime,
		timeSinceLastEvent: Date.now() - lastEventTime,
		healthy: isConnected && Date.now() - lastEventTime < 60_000,
	}
}

export function getEventStats() {
	return { events: totalEvents, matched: totalMatched }
}

let directScopeDids = new Set<string>()
let backlinkScopeDids = new Set<string>()
let firehoseStarted = false

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false
	for (const v of a) if (!b.has(v)) return false
	return true
}

export function initScopeDids(webhooks: Array<{ record: { scope: { aturi: string; backlinks?: boolean } } }>): void {
	const newDirectDids = new Set<string>()
	const newBacklinkDids = new Set<string>()
	for (const w of webhooks) {
		const did = w.record.scope.aturi.replace(/^at:\/\//, '').split('/')[0]
		if (!did) continue
		newDirectDids.add(did)
		if (w.record.scope.backlinks) newBacklinkDids.add(did)
	}

	const directChanged = !setsEqual(directScopeDids, newDirectDids)
	const backlinkChanged = !setsEqual(backlinkScopeDids, newBacklinkDids)

	directScopeDids = newDirectDids
	backlinkScopeDids = newBacklinkDids

	logger.info(`[registry] tracking ${directScopeDids.size} scope DID(s), ${backlinkScopeDids.size} with backlinks`)

	if (!firehoseStarted) return

	if (directChanged) {
		restartDirectJetstream()
	}

	if (backlinkChanged) {
		if (backlinkScopeDids.size > 0 && !backlinkJetstream) {
			startBacklinkJetstream()
		} else if (backlinkScopeDids.size === 0 && backlinkJetstream) {
			stopBacklinkJetstream()
		}
	}
}

function extractAtUriDids(obj: unknown, found: Set<string>): void {
	if (typeof obj === 'string') {
		if (obj.startsWith('at://')) {
			const rest = obj.slice(5)
			const slash = rest.indexOf('/')
			const did = slash === -1 ? rest : rest.slice(0, slash)
			if (did) found.add(did)
		}
		return
	}
	if (Array.isArray(obj)) {
		for (const v of obj) extractAtUriDids(v, found)
		return
	}
	if (obj !== null && typeof obj === 'object') {
		for (const v of Object.values(obj)) extractAtUriDids(v, found)
	}
}

function recordReferencesAnyOf(record: unknown, dids: Set<string>): boolean {
	if (record == null || dids.size === 0) return false
	const found = new Set<string>()
	extractAtUriDids(record, found)
	for (const did of found) {
		if (dids.has(did)) return true
	}
	return false
}

async function getWebhooksForEvent(eventDid: string, eventRecord: unknown) {
	let direct = getCached(eventDid)
	if (!direct) {
		direct = await findWebhooksForDid(eventDid)
		setCached(eventDid, direct)
	}

	let backlink = getCached('__backlinks__')
	if (!backlink || backlink.length === 0) {
		backlink = await findBacklinkWebhooks()
		if (backlink.length > 0) setCached('__backlinks__', backlink)
	}

	const includeBacklinks = backlink.length > 0 && recordReferencesAnyOf(eventRecord, backlinkScopeDids)
	if (!includeBacklinks) return direct

	const seen = new Set(direct.map((e) => `${e.ownerDid}/${e.rkey}`))
	const combined = [...direct]
	for (const entry of backlink) {
		const k = `${entry.ownerDid}/${entry.rkey}`
		if (!seen.has(k)) {
			seen.add(k)
			combined.push(entry)
		}
	}
	return combined
}

async function deliver(
	did: string,
	collection: string,
	rkey: string,
	op: string,
	cid: string | undefined,
	record: unknown,
): Promise<void> {
	const candidates = await getWebhooksForEvent(did, record)
	if (candidates.length === 0) return

	const matched = matchWebhooks(candidates, did, collection, rkey, op as any, record)

	if (process.env.FILTER_DEBUG) {
		for (const c of candidates) {
			logger.debug(
				matched.includes(c)
					? `[filter] ✓ ${c.ownerDid}/${c.rkey}  scope=${c.record.scope.aturi}`
					: `[filter] ✗ ${c.ownerDid}/${c.rkey}  scope=${c.record.scope.aturi}`,
			)
		}
	}

	if (matched.length === 0) return
	totalMatched += matched.length
	logger.info(`[deliver] ${op} ${did}/${collection}/${rkey} → ${matched.length} webhook(s)`)
	await Promise.allSettled(matched.map((entry) => deliverWebhook(entry, did, collection, rkey, op as any, cid, record)))
}

async function handleWhRecord(op: string, did: string, rkey: string, record: unknown): Promise<void> {
	logger.info(`[wh] ${op} ${did}/${rkey}`)
	let changed = true
	if (op === 'delete') {
		deleteWebhookRecord(did, rkey).catch((err) => logger.error(`[DB] delete ${did}/${rkey}`, err))
	} else if (record) {
		const wh = record as WhRecord
		if (!wh.scope?.aturi || !wh.url) {
			logger.error(`[wh] Skipping ${did}/${rkey} — invalid record`, { record })
			return
		}
		logger.info(`[wh] scope=${wh.scope.aturi} url=${wh.url} enabled=${wh.enabled ?? true}`)
		changed = await upsertWebhookRecord(did, rkey, wh).catch((err) => {
			logger.error(`[DB] upsert ${did}/${rkey}`, err)
			return false
		})
	} else {
		logger.warn(`[wh] ${op} ${did}/${rkey} — record missing`)
		return
	}
	if (!changed) {
		logger.debug(`[wh] ${did}/${rkey} unchanged, skipping reload`)
		return
	}
	invalidate(did)
	invalidate('__backlinks__')
	loadAllWebhooks()
		.then(initScopeDids)
		.catch(() => {})
}

let directJetstream: JetstreamClient | null = null

async function handleDirectEvent(event: JetstreamEvent): Promise<void> {
	try {
		if (event.kind !== 'commit' || !event.commit) return
		lastEventTime = Date.now()
		const { did } = event
		const { operation: op, collection, rkey, record, cid } = event.commit
		if (op !== 'create' && op !== 'update' && op !== 'delete') return
		totalEvents++

		if (collection === 'place.wisp.v2.wh') {
			await handleWhRecord(op, did, rkey, record)
			return
		}

		await deliver(did, collection, rkey, op, cid, record)
	} catch (err) {
		logger.error('Direct Jetstream event error', err)
	}
}

function restartDirectJetstream(overrideCursor?: number): void {
	const cursor = overrideCursor ?? directJetstream?.cursor
	directJetstream?.destroy()

	if (directScopeDids.size === 0) {
		directJetstream = null
		return
	}

	directJetstream = new JetstreamClient({
		url: config.jetstreamUrl,
		wantedDids: [...directScopeDids],
		cursor,
		onEvent: handleDirectEvent,
		onError: (err) => logger.error('Direct Jetstream error', err),
		onConnect: () => {
			isConnected = true
			logger.info('Direct Jetstream connected')
		},
		onDisconnect: () => {
			isConnected = false
		},
	})
	directJetstream.start()
}

let backlinkJetstream: JetstreamClient | null = null

async function handleBacklinkEvent(event: JetstreamEvent): Promise<void> {
	try {
		if (event.kind !== 'commit' || !event.commit) return
		lastEventTime = Date.now()
		const { did } = event
		const { operation: op, collection, rkey, record, cid } = event.commit
		if (op !== 'create' && op !== 'update' && op !== 'delete') return

		if (collection === 'place.wisp.v2.wh' && !directScopeDids.has(did)) {
			await handleWhRecord(op, did, rkey, record)
			return
		}

		// Skip events from scoped DIDs — the direct jetstream already handles those
		if (directScopeDids.has(did)) return

		if (!recordReferencesAnyOf(record, backlinkScopeDids)) return

		await deliver(did, collection, rkey, op, cid, record)
	} catch (err) {
		logger.error('Backlink Jetstream event error', err)
	}
}

function startBacklinkJetstream(cursor?: number): void {
	backlinkJetstream = new JetstreamClient({
		url: config.jetstreamUrl,
		cursor,
		onEvent: handleBacklinkEvent,
		onError: (err) => logger.error('Backlink Jetstream error', err),
		onConnect: () => logger.info('Backlink Jetstream connected'),
		onDisconnect: () => logger.warn('Backlink Jetstream disconnected, reconnecting'),
	})
	backlinkJetstream.start()
}

function stopBacklinkJetstream(): void {
	backlinkJetstream?.destroy()
	backlinkJetstream = null
}

export function startFirehose(initialCursor?: number): void {
	logger.info(`Jetstream: ${config.jetstreamUrl}`)
	if (initialCursor !== undefined) {
		logger.info(`Resuming from cursor ${initialCursor}`)
	}
	firehoseStarted = true
	restartDirectJetstream(initialCursor)
	if (backlinkScopeDids.size > 0) startBacklinkJetstream(initialCursor)

	setInterval(() => {
		if (Date.now() - lastEventTime > 30_000) {
			logger.warn(`No events for ${Math.round((Date.now() - lastEventTime) / 1000)}s`)
		}
	}, 30_000)

	let lastSavedCursor: number | undefined
	setInterval(() => {
		const direct = directJetstream?.cursor
		const backlink = backlinkJetstream?.cursor
		const cursor =
			direct !== undefined && backlink !== undefined
				? Math.max(direct, backlink)
				: (direct ?? backlink ?? (isConnected ? Date.now() * 1000 : undefined))
		if (cursor !== undefined && cursor !== lastSavedCursor) {
			lastSavedCursor = cursor
			saveCursor(cursor, config.jetstreamUrl)
				.then(() => logger.debug(`[cursor] Saved ${cursor}`))
				.catch((err) => logger.error('[cursor] Failed to save cursor', err))
		}
	}, 5_000)
}

export function stopFirehose(): void {
	logger.info('Stopping Jetstream consumers')
	isConnected = false
	directJetstream?.destroy()
	directJetstream = null
	stopBacklinkJetstream()
}
