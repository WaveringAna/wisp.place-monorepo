import { createHmac, randomUUID } from 'node:crypto'
import { createLogger } from '@wispplace/observability'
import { config } from '../config'
import type { WebhookEntry } from './db'
import { insertEventLog } from './db'
import type { EventKind } from './matcher'
import { publishWebhookEvent } from './redis'

const logger = createLogger('webhook-service:delivery')

export interface WebhookPayload {
	id: string
	event: EventKind
	did: string
	collection: string
	rkey: string
	cid?: string
	record?: unknown
	timestamp: string
}

/**
 * Signs a payload body with the webhook's shared secret using HMAC-SHA256.
 * Returns a `sha256=<hex>` string for the `X-Webhook-Signature` header.
 * Note: the secret is stored in the user's PDS record, so this provides
 * transport integrity rather than authentication of the sender.
 */
function sign(secret: string, body: string): string {
	return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

async function attempt(url: string, body: string, signature?: string): Promise<void> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'User-Agent': 'wisp.place-webhook/1.0',
	}
	if (signature) headers['X-Webhook-Signature'] = signature

	const res = await fetch(url, {
		method: 'POST',
		headers,
		body,
		signal: AbortSignal.timeout(config.deliveryTimeoutMs),
	})

	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`)
	}
}

/**
 * Delivers a firehose event to a webhook URL with exponential backoff retries.
 * The payload includes the event kind, AT-URI components, CID, full record, and a unique ID.
 * If the webhook record has a `secret`, the payload is signed and the signature is sent
 * in the `X-Webhook-Signature` header.
 */
export async function deliverWebhook(
	entry: WebhookEntry,
	eventDid: string,
	eventCollection: string,
	eventRkey: string,
	eventKind: EventKind,
	eventCid?: string,
	eventRecord?: unknown,
): Promise<void> {
	const { record, ownerDid, rkey } = entry
	const payload: WebhookPayload = {
		id: randomUUID(),
		event: eventKind,
		did: eventDid,
		collection: eventCollection,
		rkey: eventRkey,
		cid: eventCid,
		record: eventRecord,
		timestamp: new Date().toISOString(),
	}

	const body = JSON.stringify(payload)
	const signature = record.secret ? sign(record.secret, body) : undefined

	for (let attempt_n = 1; attempt_n <= config.deliveryMaxRetries; attempt_n++) {
		try {
			await attempt(record.url, body, signature)
			logger.info(`[delivery] ok ${ownerDid}/${rkey} → ${record.url}`)
			const okEvent = {
				ownerDid,
				rkey,
				url: record.url,
				eventKind,
				eventDid,
				eventCollection,
				eventRkey,
				cid: eventCid,
				deliveredAt: payload.timestamp,
				status: 'ok' as const,
			}
			publishWebhookEvent(okEvent).catch(() => {})
			insertEventLog(okEvent).catch(() => {})
			return
		} catch (err) {
			const isLast = attempt_n === config.deliveryMaxRetries
			if (isLast) {
				logger.warn(`Failed to deliver webhook ${ownerDid}/${rkey} → ${record.url} after ${attempt_n} attempts`, {
					err,
				})
				const failEvent = {
					ownerDid,
					rkey,
					url: record.url,
					eventKind,
					eventDid,
					eventCollection,
					eventRkey,
					cid: eventCid,
					deliveredAt: new Date().toISOString(),
					status: 'failed' as const,
				}
				publishWebhookEvent(failEvent).catch(() => {})
				insertEventLog(failEvent).catch(() => {})
			} else {
				const delay = 1000 * 2 ** (attempt_n - 1)
				await new Promise((r) => setTimeout(r, delay))
			}
		}
	}
}
