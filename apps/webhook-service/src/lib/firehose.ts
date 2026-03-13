import { IdResolver } from '@atproto/identity'
import { Firehose } from '@atproto/sync'
import { BunFirehose, type CommitEvt, type Event, isBun } from '@wispplace/bun-firehose'
import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import { createLogger } from '@wispplace/observability'
import { config } from '../config'
import { deleteWebhookRecord, findBacklinkWebhooks, findWebhooksForDid, upsertWebhookRecord } from './db'
import { deliverWebhook } from './delivery'
import { matchWebhooks } from './matcher'
import { getCached, invalidate, setCached } from './registry'

const logger = createLogger('webhook-service:firehose')
const idResolver = new IdResolver()

let lastEventTime = Date.now()
let isConnected = false

export function getFirehoseHealth() {
	return {
		connected: isConnected,
		lastEventTime,
		timeSinceLastEvent: Date.now() - lastEventTime,
		healthy: isConnected && Date.now() - lastEventTime < 60000,
	}
}

async function getWebhooksForEvent(eventDid: string) {
	// Direct scope matches: cached by eventDid
	let direct = getCached(eventDid)
	if (!direct) {
		direct = await findWebhooksForDid(eventDid)
		setCached(eventDid, direct)
	}

	// Backlink matches: cached under a fixed key
	let backlink = getCached('__backlinks__')
	if (!backlink) {
		backlink = await findBacklinkWebhooks()
		setCached('__backlinks__', backlink)
	}

	// Combine, deduplicate by ownerDid/rkey
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

async function handleEvent(evt: Event | CommitEvt): Promise<void> {
	try {
		lastEventTime = Date.now()

		if (!('event' in evt)) return
		if (evt.event !== 'create' && evt.event !== 'update' && evt.event !== 'delete') return
		const { did, collection, rkey, record, cid, event } = evt as CommitEvt

		// Keep DB up to date and invalidate cache when webhook records change
		if (collection === 'place.wisp.v2.wh') {
			logger.info(`[wh] Received ${event} for ${did}/${rkey}`)
			if (event === 'delete') {
				deleteWebhookRecord(did, rkey).catch((err) => logger.error(`[DB] Failed to delete webhook ${did}/${rkey}`, err))
			} else if (record) {
				logger.debug(`[wh] raw record: ${JSON.stringify(record)}`)
				const wh = record as WhRecord
				if (!wh.scope?.aturi || !wh.url) {
					logger.error(`[wh] Skipping ${did}/${rkey} — record failed validation`, { record })
				} else {
					logger.info(`[wh] scope=${wh.scope.aturi} url=${wh.url} enabled=${wh.enabled ?? true}`)
					upsertWebhookRecord(did, rkey, wh).catch((err) =>
						logger.error(`[DB] Failed to upsert webhook ${did}/${rkey}`, err),
					)
				}
			} else {
				logger.warn(`[wh] ${event} ${did}/${rkey} — record missing from commit`)
			}
			invalidate(did)
			invalidate('__backlinks__')
			return
		}

		// Lookup webhooks for this event (cache-first)
		const candidates = await getWebhooksForEvent(did)
		if (candidates.length === 0) return

		const matched = matchWebhooks(candidates, did, collection, rkey, event, record)
		if (matched.length === 0) return

		logger.info(`[deliver] ${event} ${did}/${collection}/${rkey} → ${matched.length} webhook(s)`)

		await Promise.allSettled(
			matched.map((entry) => deliverWebhook(entry, did, collection, rkey, event, cid?.toString(), record)),
		)
	} catch (err) {
		logger.error('Unexpected error in handleEvent', err)
	}
}

function handleError(err: Error): void {
	logger.error('Firehose error', err)
}

let firehoseHandle: { destroy: () => void } | null = null

export function startFirehose(): void {
	logger.info(`Starting firehose (runtime: ${isBun ? 'Bun' : 'Node.js'})`)

	if (isBun) {
		const f = new BunFirehose({
			idResolver,
			service: config.firehoseService,
			unauthenticatedCommits: true,
			handleEvent,
			onError: handleError,
			onConnect: () => {
				isConnected = true
				logger.info('Firehose connected')
			},
			onDisconnect: () => {
				isConnected = false
				logger.warn('Firehose disconnected, will reconnect')
			},
		})
		f.start()
		firehoseHandle = { destroy: () => f.destroy() }
	} else {
		isConnected = true
		const f = new Firehose({
			idResolver,
			service: config.firehoseService,
			handleEvent: handleEvent as any,
			onError: handleError,
		})
		f.start()
		firehoseHandle = { destroy: () => f.destroy() }
	}

	setInterval(() => {
		const health = getFirehoseHealth()
		if (health.timeSinceLastEvent > 30000) {
			logger.warn(`No firehose events for ${Math.round(health.timeSinceLastEvent / 1000)}s`)
		} else {
			logger.info(`Firehose alive, last event ${Math.round(health.timeSinceLastEvent / 1000)}s ago`)
		}
	}, 30000)
}

export function stopFirehose(): void {
	logger.info('Stopping firehose')
	isConnected = false
	firehoseHandle?.destroy()
	firehoseHandle = null
}
