import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import { createLogger } from '@wispplace/observability'
import { config } from '../config'
import {
	deleteWebhookRecord,
	findBacklinkWebhooks,
	findWebhooksForDid,
	loadAllWebhooks,
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

export function initScopeDids(webhooks: Array<{ record: { scope: { aturi: string; backlinks?: boolean } } }>): void {
	directScopeDids = new Set()
	backlinkScopeDids = new Set()
	for (const w of webhooks) {
		const did = w.record.scope.aturi.replace(/^at:\/\//, '').split('/')[0]
		if (!did) continue
		directScopeDids.add(did)
		if (w.record.scope.backlinks) backlinkScopeDids.add(did)
	}
	logger.info(`[registry] tracking ${directScopeDids.size} scope DID(s), ${backlinkScopeDids.size} with backlinks`)
	restartDirectJetstream()
	if (backlinkScopeDids.size > 0 && !backlinkJetstream) {
		startBacklinkJetstream()
	} else if (backlinkScopeDids.size === 0 && backlinkJetstream) {
		stopBacklinkJetstream()
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
	if (!backlink) {
		backlink = await findBacklinkWebhooks()
		setCached('__backlinks__', backlink)
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
	if (op === 'delete') {
		deleteWebhookRecord(did, rkey).catch((err) => logger.error(`[DB] delete ${did}/${rkey}`, err))
	} else if (record) {
		const wh = record as WhRecord
		if (!wh.scope?.aturi || !wh.url) {
			logger.error(`[wh] Skipping ${did}/${rkey} — invalid record`, { record })
		} else {
			logger.info(`[wh] scope=${wh.scope.aturi} url=${wh.url} enabled=${wh.enabled ?? true}`)
			upsertWebhookRecord(did, rkey, wh).catch((err) => logger.error(`[DB] upsert ${did}/${rkey}`, err))
		}
	} else {
		logger.warn(`[wh] ${op} ${did}/${rkey} — record missing`)
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

function restartDirectJetstream(): void {
	const cursor = directJetstream?.cursor
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

		if (!recordReferencesAnyOf(record, backlinkScopeDids)) return

		await deliver(did, collection, rkey, op, cid, record)
	} catch (err) {
		logger.error('Backlink Jetstream event error', err)
	}
}

function startBacklinkJetstream(): void {
	backlinkJetstream = new JetstreamClient({
		url: config.jetstreamUrl,
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

export function startFirehose(): void {
	logger.info(`Jetstream: ${config.jetstreamUrl}`)
	restartDirectJetstream()
	if (backlinkScopeDids.size > 0) startBacklinkJetstream()

	setInterval(() => {
		if (Date.now() - lastEventTime > 30_000) {
			logger.warn(`No events for ${Math.round((Date.now() - lastEventTime) / 1000)}s`)
		}
	}, 30_000)
}

export function stopFirehose(): void {
	logger.info('Stopping Jetstream consumers')
	isConnected = false
	directJetstream?.destroy()
	directJetstream = null
	stopBacklinkJetstream()
}
