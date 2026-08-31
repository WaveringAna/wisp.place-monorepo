import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createLogger } from '@wispplace/observability'
import { MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS } from './admission'
import { isValidAtprotoRevision } from './atproto-revision'
import type {
	ClaimedWebhookDelivery,
	CurrentWebhookSubscription,
	NewWebhookDeliveryEventRow,
	NewWebhookDeliveryOutboxRow,
	WebhookEntry,
} from './db'
import * as database from './db'
import type { EventKind } from './matcher'
import * as redis from './redis'
import {
	discardWebhookResponse,
	pinnedWebhookFetch,
	type WebhookResolver,
	type WebhookTransport,
	WebhookUrlError,
} from './webhook-url'

const logger = createLogger('webhook-service:delivery')

export const MAX_WEBHOOK_DELIVERY_ENQUEUE_BATCH = 1_000
/** Kept exported for callers; it is the exact registry admission ceiling. */
export const MAX_WEBHOOK_DELIVERY_FANOUT = MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS
const MAX_EVENT_FIELD_LENGTH = 2_048
const MAX_PAYLOAD_BYTES = 512 * 1024
const MAX_PAYLOAD_NODES = 10_000
/** Bound allocation and one DB round trip even for a valid high-fanout event. */
export const MAX_WEBHOOK_DELIVERY_ENQUEUE_CHUNK_BYTES = 4 * 1024 * 1024
export const MAX_WEBHOOK_DELIVERY_EVENT_BYTES = 16 * 1024 * 1024

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

/** Source identity is deliberately independent of direct/backlink consumer name. */
export interface WebhookDeliveryEvent {
	relay: string
	timeUs: number
	rev: string
	operation: EventKind
	did: string
	collection: string
	rkey: string
	cid?: string
	record?: unknown
}

export interface EnqueueWebhookDeliveriesResult {
	enqueued: number
	deduplicated: number
}

export type WebhookDeliveryInputErrorKind =
	| 'invalid_event'
	| 'invalid_subscription'
	| 'payload_invalid'
	| 'payload_too_large'
	| 'fanout_limit'

/** A deterministic bad input may be quarantined/acknowledged by intake; DB errors must still retry. */
export class WebhookDeliveryInputError extends Error {
	constructor(
		public readonly kind: WebhookDeliveryInputErrorKind,
		message: string,
	) {
		super(message)
		this.name = 'WebhookDeliveryInputError'
	}
}

function boundedString(value: unknown, maximum = MAX_EVENT_FIELD_LENGTH): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function canonicalize(value: unknown, depth = 0, state = { nodes: 0 }): unknown {
	state.nodes++
	if (depth > 32 || state.nodes > MAX_PAYLOAD_NODES) {
		throw new WebhookDeliveryInputError('payload_invalid', 'Webhook payload is invalid')
	}
	if (value === null || typeof value === 'boolean') return value
	if (typeof value === 'string') {
		// Avoid allocating/serializing an unbounded individual string before the
		// final UTF-8 byte cap below.
		if (value.length > MAX_PAYLOAD_BYTES) {
			throw new WebhookDeliveryInputError('payload_too_large', 'Webhook payload is too large')
		}
		return value
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new WebhookDeliveryInputError('payload_invalid', 'Webhook payload is invalid')
		return value
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_PAYLOAD_NODES) {
			throw new WebhookDeliveryInputError('payload_invalid', 'Webhook payload is invalid')
		}
		return value.map((entry) => canonicalize(entry, depth + 1, state))
	}
	if (typeof value === 'object') {
		const input = value as Record<string, unknown>
		const keys = Object.keys(input)
		if (keys.length > MAX_PAYLOAD_NODES) {
			throw new WebhookDeliveryInputError('payload_invalid', 'Webhook payload is invalid')
		}
		const output: Record<string, unknown> = {}
		for (const key of keys.sort()) {
			if (key.length > 512) throw new WebhookDeliveryInputError('payload_invalid', 'Webhook payload is invalid')
			output[key] = canonicalize(input[key], depth + 1, state)
		}
		return output
	}
	throw new WebhookDeliveryInputError('payload_invalid', 'Webhook payload is invalid')
}

/** JSON with sorted object keys, so stored bytes and HMAC input are stable. */
export function canonicalWebhookJson(value: unknown): string {
	let encoded: string
	try {
		encoded = JSON.stringify(canonicalize(value))
	} catch {
		throw new WebhookDeliveryInputError('payload_invalid', 'Webhook payload is invalid')
	}
	if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > MAX_PAYLOAD_BYTES) {
		throw new WebhookDeliveryInputError('payload_too_large', 'Webhook payload is too large')
	}
	return encoded
}

function normalizedRelayIdentity(relay: string): { canonical: string; hash: string } {
	if (!boundedString(relay)) throw new WebhookDeliveryInputError('invalid_event', 'Webhook event is invalid')
	let parsed: URL
	try {
		parsed = new URL(relay)
	} catch {
		throw new WebhookDeliveryInputError('invalid_event', 'Webhook event is invalid')
	}
	if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') || !parsed.hostname)
		throw new WebhookDeliveryInputError('invalid_event', 'Webhook event is invalid')
	parsed.username = ''
	parsed.password = ''
	parsed.search = ''
	parsed.hash = ''
	parsed.hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
	const canonical = `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}`
	return {
		canonical,
		hash: createHash('sha256').update(`wisp-jetstream-relay/v1\0${canonical}`).digest('hex'),
	}
}

function timestampForTimeUs(timeUs: number): string {
	if (!Number.isSafeInteger(timeUs) || timeUs < 0)
		throw new WebhookDeliveryInputError('invalid_event', 'Webhook event is invalid')
	const date = new Date(timeUs / 1_000)
	if (Number.isNaN(date.getTime())) throw new WebhookDeliveryInputError('invalid_event', 'Webhook event is invalid')
	return date.toISOString()
}

function assertEvent(event: WebhookDeliveryEvent): void {
	if (!event || typeof event !== 'object')
		throw new WebhookDeliveryInputError('invalid_event', 'Webhook event is invalid')
	if (event.operation !== 'create' && event.operation !== 'update' && event.operation !== 'delete')
		throw new WebhookDeliveryInputError('invalid_event', 'Webhook event is invalid')
	if (
		!isValidAtprotoRevision(event.rev) ||
		!boundedString(event.did) ||
		!boundedString(event.collection) ||
		!boundedString(event.rkey) ||
		(event.cid !== undefined && !boundedString(event.cid, 1_024))
	) {
		throw new WebhookDeliveryInputError('invalid_event', 'Webhook event is invalid')
	}
	timestampForTimeUs(event.timeUs)
	normalizedRelayIdentity(event.relay)
}

/** One immutable event body is shared across every subscription delivery. */
export function createWebhookDeliveryEventId(event: WebhookDeliveryEvent): string {
	assertEvent(event)
	const identity = canonicalWebhookJson({
		version: 1,
		relay: normalizedRelayIdentity(event.relay).canonical,
		timeUs: event.timeUs,
		rev: event.rev,
		operation: event.operation,
		did: event.did,
		collection: event.collection,
		rkey: event.rkey,
		cid: event.cid ?? null,
	})
	return `whe_v1_${createHash('sha256').update(identity).digest('hex')}`
}

/** A versioned deterministic Idempotency-Key for one subscription delivery. */
export function createWebhookDeliveryId(event: WebhookDeliveryEvent, ownerDid: string, webhookRkey: string): string {
	assertEvent(event)
	if (!boundedString(ownerDid) || !boundedString(webhookRkey, 1_024))
		throw new WebhookDeliveryInputError('invalid_subscription', 'Webhook subscription is invalid')
	const identity = canonicalWebhookJson({
		version: 1,
		relay: normalizedRelayIdentity(event.relay).canonical,
		timeUs: event.timeUs,
		rev: event.rev,
		operation: event.operation,
		did: event.did,
		collection: event.collection,
		rkey: event.rkey,
		cid: event.cid ?? null,
		ownerDid,
		webhookRkey,
	})
	return `whd_v1_${createHash('sha256').update(identity).digest('hex')}`
}

/** Do not copy a webhook signing secret into an event payload/outbox row. */
function payloadRecord(event: WebhookDeliveryEvent): unknown {
	if (event.record === undefined) return undefined
	if (
		event.collection !== 'place.wisp.v2.wh' ||
		!event.record ||
		typeof event.record !== 'object' ||
		Array.isArray(event.record)
	) {
		return event.record
	}
	const copy = { ...(event.record as Record<string, unknown>) }
	delete copy.secret
	return copy
}

interface SubscriptionDeliveryMetadata {
	fingerprint: string
	signingMode: NewWebhookDeliveryOutboxRow['signingMode']
	secretId?: string
}

/** Validate only fields needed by the outbox; never materialize a record snapshot. */
function subscriptionDeliveryMetadata(
	entry: WebhookEntry,
	fingerprintForRecord: (record: WebhookEntry['record']) => string,
): SubscriptionDeliveryMetadata {
	const record = entry.record
	if (!record || !boundedString(record.url) || !record.scope || !boundedString(record.scope.aturi)) {
		throw new WebhookDeliveryInputError('invalid_subscription', 'Webhook subscription is invalid')
	}
	const signingMode: NewWebhookDeliveryOutboxRow['signingMode'] = record.secretId
		? 'secret_id'
		: record.secret
			? 'record_secret'
			: 'none'
	try {
		return { fingerprint: fingerprintForRecord(record), signingMode, secretId: record.secretId }
	} catch {
		throw new WebhookDeliveryInputError('invalid_subscription', 'Webhook subscription is invalid')
	}
}

export interface EnqueueWebhookDeliveriesOptions {
	/** Test seam; production uses the transactional DB bulk writer. */
	enqueueOutbox?: (
		event: NewWebhookDeliveryEventRow,
		rows: readonly NewWebhookDeliveryOutboxRow[],
		ensureEvent?: boolean,
	) => Promise<{ enqueued: number; deduplicated: number }>
	/** Test seam; production uses the same fingerprint function as send-time revocation. */
	subscriptionFingerprint?: (record: WebhookEntry['record']) => string
}

function encodedBytes(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

function estimatedOutboxInputBytes(
	entry: WebhookEntry,
	metadata: SubscriptionDeliveryMetadata,
	eventId: string,
): number {
	// This covers every text parameter in the UNNEST row. No record snapshot or
	// payload body is copied into a subscription-specific row.
	return (
		encodedBytes(entry.ownerDid) +
		encodedBytes(entry.rkey) +
		encodedBytes(entry.record.url) +
		encodedBytes(metadata.secretId ?? '') +
		encodedBytes(metadata.signingMode) +
		encodedBytes(metadata.fingerprint) +
		encodedBytes(eventId) +
		80
	)
}

export async function enqueueWebhookDeliveries(
	entries: readonly WebhookEntry[],
	event: WebhookDeliveryEvent,
	options: EnqueueWebhookDeliveriesOptions = {},
): Promise<EnqueueWebhookDeliveriesResult> {
	assertEvent(event)
	const enqueueOutbox = options.enqueueOutbox ?? database.enqueueWebhookDeliveryOutbox
	const fingerprintForRecord = options.subscriptionFingerprint ?? database.webhookSubscriptionFingerprint
	if (entries.length > MAX_WEBHOOK_DELIVERY_FANOUT) {
		throw new WebhookDeliveryInputError('fanout_limit', 'Webhook delivery fanout is too large')
	}
	if (entries.length === 0) return { enqueued: 0, deduplicated: 0 }

	const relay = normalizedRelayIdentity(event.relay)
	const timestamp = timestampForTimeUs(event.timeUs)
	const record = payloadRecord(event)
	const eventId = createWebhookDeliveryEventId(event)
	const payload: WebhookPayload = {
		id: eventId,
		event: event.operation,
		did: event.did,
		collection: event.collection,
		rkey: event.rkey,
		...(event.cid === undefined ? {} : { cid: event.cid }),
		...(record === undefined ? {} : { record }),
		timestamp,
	}
	const payloadJson = canonicalWebhookJson(payload)
	const eventRow: NewWebhookDeliveryEventRow = {
		eventId,
		payloadJson,
		sourceRelayId: relay.hash,
		sourceTimeUs: event.timeUs,
		sourceRevision: event.rev,
		sourceOperation: event.operation,
	}

	// Preflight all subscription snapshots before committing any chunk. A
	// deterministic fanout/input breach is quarantined as one event, never
	// partially delivered. The estimates bound both the entire event and every
	// typed-UNNEST parameter batch.
	const rowMetadata: SubscriptionDeliveryMetadata[] = []
	const rowInputBytes: number[] = []
	let eventInputBytes = encodedBytes(payloadJson)
	for (const entry of entries) {
		if (!boundedString(entry.ownerDid) || !boundedString(entry.rkey, 1_024)) {
			throw new WebhookDeliveryInputError('invalid_subscription', 'Webhook subscription is invalid')
		}
		const metadata = subscriptionDeliveryMetadata(entry, fingerprintForRecord)
		const estimated = estimatedOutboxInputBytes(entry, metadata, eventId)
		eventInputBytes += estimated
		if (eventInputBytes > MAX_WEBHOOK_DELIVERY_EVENT_BYTES) {
			throw new WebhookDeliveryInputError('fanout_limit', 'Webhook delivery fanout is too large')
		}
		rowMetadata.push(metadata)
		rowInputBytes.push(estimated)
	}

	let enqueued = 0
	let deduplicated = 0
	let offset = 0
	// A large valid fanout commits deterministic bounded chunks. A later DB
	// failure leaves earlier stable IDs safely dedupable on replay; intake only
	// acknowledges after the whole function resolves.
	while (offset < entries.length) {
		let end = offset
		let chunkInputBytes = 0
		while (end < entries.length && end - offset < MAX_WEBHOOK_DELIVERY_ENQUEUE_BATCH) {
			const estimated = rowInputBytes[end]
			if (estimated === undefined) throw new Error('Invalid webhook delivery estimate')
			if (end > offset && chunkInputBytes + estimated > MAX_WEBHOOK_DELIVERY_ENQUEUE_CHUNK_BYTES) break
			chunkInputBytes += estimated
			end++
		}
		const rows: NewWebhookDeliveryOutboxRow[] = []
		for (let index = offset; index < end; index++) {
			const entry = entries[index]
			if (!entry) throw new Error('Invalid webhook delivery entry')
			const deliveryId = createWebhookDeliveryId(event, entry.ownerDid, entry.rkey)
			const metadata = rowMetadata[index]
			if (!metadata) throw new Error('Invalid webhook delivery metadata')
			rows.push({
				deliveryId,
				eventId,
				ownerDid: entry.ownerDid,
				webhookRkey: entry.rkey,
				targetUrl: entry.record.url,
				secretId: metadata.secretId,
				signingMode: metadata.signingMode,
				subscriptionFingerprint: metadata.fingerprint,
			})
		}
		const result = await enqueueOutbox(eventRow, rows, offset === 0)
		enqueued += result.enqueued
		deduplicated += result.deduplicated
		offset = end
	}
	return { enqueued, deduplicated }
}

/** HMAC over exactly the canonical payload bytes stored in the outbox. */
export function signWebhookBody(secret: string, body: string): string {
	return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

function syntheticLegacyRevision(seed: string): string {
	const alphabet = '234567abcdefghijklmnopqrstuvwxyz'
	const bytes = createHash('sha256').update(seed).digest()
	let result = ''
	for (let index = 0; index < 13; index++) result += alphabet[(bytes[index] ?? 0) % alphabet.length]
	return result
}

/**
 * Legacy API compatibility during rolling deploys. New intake must call
 * enqueueWebhookDeliveries with source relay/time/rev before cursor advancement.
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
	const timeUs = Date.now() * 1_000
	await enqueueWebhookDeliveries([entry], {
		relay: 'wss://legacy.webhook-service.invalid/',
		timeUs,
		rev: isValidAtprotoRevision(eventCid)
			? (eventCid as string)
			: syntheticLegacyRevision(`${timeUs}:${eventCid ?? ''}`),
		operation: eventKind,
		did: eventDid,
		collection: eventCollection,
		rkey: eventRkey,
		cid: eventCid,
		record: eventRecord,
	})
}

export type DeliveryFailureKind =
	| 'subscription_unavailable'
	| 'subscription_changed'
	| 'secret_unavailable'
	| 'invalid_target'
	| 'blocked_target'
	| 'dns'
	| 'timeout'
	| 'network'
	| 'redirect'
	| 'request_too_large'
	| 'response_too_large'
	| 'http_4xx'
	| 'http_5xx'
	| 'internal'

interface AttemptResult {
	status: number
	retryAfterMs?: number
}

interface DeliveryFailure {
	kind: DeliveryFailureKind
	transient: boolean
	httpStatus?: number
	retryAfterMs?: number
}

function boundedOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined) return fallback
	if (!Number.isFinite(value)) return fallback
	return Math.max(minimum, Math.min(maximum, Math.floor(value)))
}

/** Narrow persistence seam keeps worker shutdown behavior testable without a live DB. */
export type WebhookDeliveryWorkerPersistence = Pick<
	typeof database,
	| 'cancelWebhookDeliveryForSubscriptionChange'
	| 'claimWebhookDeliveryOutbox'
	| 'getCurrentWebhookSubscription'
	| 'getWebhookInlineSecret'
	| 'getWebhookSecretToken'
	| 'markWebhookDeliverySucceeded'
	| 'renewWebhookDeliveryLease'
	| 'rescheduleWebhookDelivery'
	| 'runWebhookMaintenance'
>

export interface WebhookDeliveryWorkerOptions {
	concurrency?: number
	batchSize?: number
	pollIntervalMs?: number
	leaseMs?: number
	maxAttempts?: number
	retryBaseMs?: number
	retryMaxMs?: number
	requestTimeoutMs?: number
	maxRequestBytes?: number
	maxResponseBytes?: number
	maxRedirects?: number
	maintenanceIntervalMs?: number
	deliveredRetentionMs?: number
	deadLetterRetentionMs?: number
	resolver?: WebhookResolver
	transport?: WebhookTransport
	/** Development-only request escape; webhook-url independently enforces its env gates. */
	allowLoopback?: boolean
	random?: () => number
	workerId?: string
	/** Test seam; production uses the normal durable DB module. */
	persistence?: WebhookDeliveryWorkerPersistence
}

interface BoundedWorkerOptions {
	concurrency: number
	batchSize: number
	pollIntervalMs: number
	leaseMs: number
	maxAttempts: number
	retryBaseMs: number
	retryMaxMs: number
	requestTimeoutMs: number
	maxRequestBytes: number
	maxResponseBytes: number
	maxRedirects: number
	maintenanceIntervalMs: number
	deliveredRetentionMs: number
	deadLetterRetentionMs: number
	resolver?: WebhookResolver
	transport?: WebhookTransport
	allowLoopback: boolean
	random: () => number
	workerId: string
	persistence: WebhookDeliveryWorkerPersistence
}

function boundWorkerOptions(options: WebhookDeliveryWorkerOptions): BoundedWorkerOptions {
	const retryBaseMs = boundedOption(options.retryBaseMs, 1_000, 100, 60_000)
	const retryMaxMs = boundedOption(options.retryMaxMs, 5 * 60_000, retryBaseMs, 60 * 60_000)
	const requestTimeoutMs = boundedOption(options.requestTimeoutMs, 10_000, 100, 30_000)
	// A claim covers one HTTP attempt only. Keep enough room for response
	// cancellation and the terminal DB update; retries are rescheduled, not held.
	const leaseMs = boundedOption(
		options.leaseMs,
		Math.max(60_000, requestTimeoutMs + 5_000),
		requestTimeoutMs + 5_000,
		10 * 60_000,
	)
	return {
		concurrency: boundedOption(options.concurrency, 4, 1, 32),
		batchSize: boundedOption(options.batchSize, 32, 1, 256),
		pollIntervalMs: boundedOption(options.pollIntervalMs, 1_000, 100, 60_000),
		leaseMs,
		maxAttempts: boundedOption(options.maxAttempts, 12, 1, 50),
		retryBaseMs,
		retryMaxMs,
		requestTimeoutMs,
		maxRequestBytes: boundedOption(options.maxRequestBytes, MAX_PAYLOAD_BYTES, 1, MAX_PAYLOAD_BYTES),
		maxResponseBytes: boundedOption(options.maxResponseBytes, 64 * 1024, 0, 512 * 1024),
		maxRedirects: boundedOption(options.maxRedirects, 3, 0, 5),
		maintenanceIntervalMs: boundedOption(options.maintenanceIntervalMs, 60_000, 10_000, 60 * 60_000),
		deliveredRetentionMs: boundedOption(
			options.deliveredRetentionMs,
			7 * 24 * 60 * 60_000,
			60_000,
			365 * 24 * 60 * 60_000,
		),
		deadLetterRetentionMs: boundedOption(
			options.deadLetterRetentionMs,
			30 * 24 * 60 * 60_000,
			60_000,
			365 * 24 * 60 * 60_000,
		),
		resolver: options.resolver,
		transport: options.transport,
		allowLoopback: options.allowLoopback === true,
		random: options.random ?? Math.random,
		workerId: boundedString(options.workerId, 256) ? options.workerId : `webhook-worker-${randomUUID()}`,
		persistence: options.persistence ?? database,
	}
}
function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
	if (!value) return undefined
	if (/^\d+$/.test(value)) return Math.min(Number(value) * 1_000, 60 * 60_000)
	const date = Date.parse(value)
	if (Number.isNaN(date)) return undefined
	return Math.max(0, Math.min(date - now, 60 * 60_000))
}

function classifyHttpStatus(status: number, retryAfterMs?: number): DeliveryFailure {
	if (status >= 200 && status < 300) return { kind: 'internal', transient: false, httpStatus: status }
	if (status >= 500 || status === 408 || status === 409 || status === 423 || status === 425 || status === 429) {
		return { kind: 'http_5xx', transient: true, httpStatus: status, retryAfterMs }
	}
	if (status >= 400 && status < 500) return { kind: 'http_4xx', transient: false, httpStatus: status }
	// Redirects should have been followed/rejected by the pinned transport; an
	// unexpected final 3xx is a target configuration problem, not a retry storm.
	return { kind: 'redirect', transient: false, httpStatus: status }
}

function failureFromError(error: unknown): DeliveryFailure {
	if (error instanceof WebhookUrlError) {
		switch (error.kind) {
			case 'invalid_url':
				return { kind: 'invalid_target', transient: false }
			case 'blocked_destination':
				return { kind: 'blocked_target', transient: false }
			case 'dns':
				return { kind: 'dns', transient: true }
			case 'timeout':
				return { kind: 'timeout', transient: true }
			case 'network':
				return { kind: 'network', transient: true }
			case 'redirect':
				return { kind: 'redirect', transient: false }
			case 'request_too_large':
				return { kind: 'request_too_large', transient: false }
			case 'response_too_large':
				return { kind: 'response_too_large', transient: false }
		}
	}
	return { kind: 'network', transient: true }
}

function retryDelayMs(attemptNumber: number, options: BoundedWorkerOptions): number {
	const exponent = Math.min(Math.max(0, attemptNumber - 1), 20)
	const maximum = Math.min(options.retryMaxMs, options.retryBaseMs * 2 ** exponent)
	const random = Math.max(0, Math.min(1, options.random()))
	return Math.max(1, Math.floor(maximum * (0.5 + random * 0.5)))
}

interface DeliveryAuditEvent {
	ownerDid: string
	rkey: string
	eventKind: EventKind
	eventDid: string
	eventCollection: string
	eventRkey: string
	cid?: string
	status: 'ok' | 'failed' | 'dead_letter'
	deliveredAt: string
}

function auditFromPayload(row: ClaimedWebhookDelivery, status: DeliveryAuditEvent['status']): DeliveryAuditEvent {
	let payload: Partial<WebhookPayload> = {}
	try {
		const parsed = JSON.parse(row.payloadBody) as unknown
		if (parsed && typeof parsed === 'object') payload = parsed as Partial<WebhookPayload>
	} catch {
		// A corrupt row is handled as a delivery failure without exposing contents.
	}
	return {
		ownerDid: row.ownerDid,
		rkey: row.webhookRkey,
		eventKind:
			payload.event === 'create' || payload.event === 'update' || payload.event === 'delete'
				? payload.event
				: row.sourceOperation === 'create' || row.sourceOperation === 'update' || row.sourceOperation === 'delete'
					? row.sourceOperation
					: 'update',
		eventDid: typeof payload.did === 'string' ? payload.did : '[unknown]',
		eventCollection: typeof payload.collection === 'string' ? payload.collection : '[unknown]',
		eventRkey: typeof payload.rkey === 'string' ? payload.rkey : '[unknown]',
		cid: typeof payload.cid === 'string' ? payload.cid : undefined,
		status,
		deliveredAt: new Date().toISOString(),
	}
}

function persistDeliveryAudit(audit: DeliveryAuditEvent): Promise<void> {
	// Audit/notification failure must never turn a durably completed delivery
	// into an unhandled rejection or cause a second POST.
	return Promise.all([
		Promise.resolve()
			.then(() => database.insertEventLog(audit))
			.catch(() => logger.warn('[delivery] audit persistence failed')),
		Promise.resolve()
			.then(() =>
				redis.publishWebhookEvent({
					...audit,
					url: '[redacted]',
					status: audit.status === 'ok' ? 'ok' : 'failed',
				}),
			)
			.catch(() => logger.warn('[delivery] audit publish failed')),
	]).then(() => undefined)
}

async function postDelivery(
	row: ClaimedWebhookDelivery,
	secret: string | undefined,
	options: BoundedWorkerOptions,
	signal: AbortSignal,
): Promise<AttemptResult> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'User-Agent': 'wisp.place-webhook/2.0',
		'Idempotency-Key': row.deliveryId,
	}
	if (secret) headers['X-Webhook-Signature'] = signWebhookBody(secret, row.payloadBody)
	const response = await pinnedWebhookFetch(row.targetUrl, {
		method: 'POST',
		headers,
		body: row.payloadBody,
		timeoutMs: options.requestTimeoutMs,
		maxRequestBytes: options.maxRequestBytes,
		maxResponseBytes: options.maxResponseBytes,
		maxRedirects: options.maxRedirects,
		resolver: options.resolver,
		transport: options.transport,
		allowLoopback: options.allowLoopback,
		signal,
	})
	const result = { status: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) }
	await discardWebhookResponse(response)
	return result
}

async function mapBounded<T>(
	values: readonly T[],
	concurrency: number,
	operation: (value: T) => Promise<void>,
): Promise<void> {
	let next = 0
	const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		while (true) {
			const index = next++
			const value = values[index]
			if (value === undefined) return
			await operation(value)
		}
	})
	await Promise.all(runners)
}

/** Maintains ownership during one bounded HTTP attempt and aborts on lease loss. */
class DeliveryLeaseHeartbeat {
	private readonly controller = new AbortController()
	private timer: ReturnType<typeof setTimeout> | undefined
	private stopped = false
	private refreshPromise: Promise<void> | undefined

	constructor(
		private readonly row: ClaimedWebhookDelivery,
		private readonly leaseMs: number,
		private readonly renewLease: WebhookDeliveryWorkerPersistence['renewWebhookDeliveryLease'],
	) {}

	get signal(): AbortSignal {
		return this.controller.signal
	}

	async acquire(): Promise<boolean> {
		if (this.stopped || this.controller.signal.aborted) return false
		try {
			const renewed = await this.renewLease(this.row.deliveryId, this.row.leaseToken, this.leaseMs)
			return renewed && !this.stopped && !this.controller.signal.aborted
		} catch {
			return false
		}
	}

	start(): void {
		this.schedule()
	}

	private schedule(): void {
		if (this.stopped || this.controller.signal.aborted || this.refreshPromise) return
		this.timer = setTimeout(() => this.refresh(), Math.max(1_000, Math.floor(this.leaseMs / 3)))
	}

	private refresh(): void {
		if (this.stopped || this.controller.signal.aborted || this.refreshPromise) return
		const pending = this.refreshOnce()
		this.refreshPromise = pending
		void pending.finally(() => {
			if (this.refreshPromise === pending) this.refreshPromise = undefined
			this.schedule()
		})
	}

	private async refreshOnce(): Promise<void> {
		try {
			const renewed = await this.renewLease(this.row.deliveryId, this.row.leaseToken, this.leaseMs)
			if (!renewed && !this.stopped) this.abort(new Error('Webhook delivery lease lost'))
		} catch {
			// Failing closed avoids a POST after DB ownership becomes uncertain.
			if (!this.stopped) this.abort(new Error('Webhook delivery lease lost'))
		}
	}

	/** Abort a pinned HTTP attempt and prevent any later lease refresh. */
	abort(reason = new Error('Webhook delivery stopped')): void {
		this.stop()
		if (!this.controller.signal.aborted) this.controller.abort(reason)
	}

	/** Stop timers and wait for an already-issued refresh before DB teardown. */
	async stopAndDrain(): Promise<void> {
		this.stop()
		await this.refreshPromise?.catch(() => undefined)
	}

	stop(): void {
		this.stopped = true
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
	}
}

export class WebhookDeliveryWorker {
	private readonly options: BoundedWorkerOptions
	private started = false
	private stopping = false
	private running = false
	private timer: ReturnType<typeof setTimeout> | undefined
	private readonly inFlight = new Set<Promise<void>>()
	private readonly activeLeases = new Set<DeliveryLeaseHeartbeat>()
	private readonly auditTasks = new Set<Promise<void>>()
	private readonly activityWaiters = new Set<() => void>()
	private lastMaintenanceAt = 0

	constructor(options: WebhookDeliveryWorkerOptions = {}) {
		this.options = boundWorkerOptions(options)
	}

	start(): void {
		if (this.started || this.stopping) return
		this.started = true
		this.schedule(0)
	}

	private schedule(delayMs: number): void {
		if (!this.started || this.stopping) return
		this.timer = setTimeout(() => {
			void this.tick()
		}, delayMs)
	}

	private async tick(): Promise<void> {
		try {
			await this.runOnce()
		} catch {
			// The queue remains durable. Keep the message safe and let the next tick retry.
			logger.error('[delivery] worker pass failed')
		} finally {
			this.schedule(this.options.pollIntervalMs)
		}
	}

	private notifyActivity(): void {
		for (const resolve of this.activityWaiters) resolve()
		this.activityWaiters.clear()
	}

	private async waitForShutdownWork(deadline: number): Promise<boolean> {
		while (this.running || this.inFlight.size > 0 || this.auditTasks.size > 0) {
			const remaining = deadline - Date.now()
			if (remaining <= 0) return false
			let resolveActivity: (() => void) | undefined
			const activity = new Promise<void>((resolve) => {
				resolveActivity = resolve
				this.activityWaiters.add(resolve)
			})
			if (!this.running && this.inFlight.size === 0 && this.auditTasks.size === 0) {
				if (resolveActivity) this.activityWaiters.delete(resolveActivity)
				return true
			}
			await Promise.race([activity, new Promise<void>((resolve) => setTimeout(resolve, remaining))])
			if (resolveActivity) this.activityWaiters.delete(resolveActivity)
		}
		return true
	}

	async runOnce(): Promise<number> {
		if (this.running || this.stopping) return 0
		this.running = true
		try {
			const leaseToken = `${this.options.workerId}:${randomUUID()}`
			// Do not prefetch leases: rows behind a slow concurrent request could
			// expire before their first POST and be claimed by another process.
			const rows = await this.options.persistence.claimWebhookDeliveryOutbox(
				leaseToken,
				Math.min(this.options.batchSize, this.options.concurrency),
				this.options.leaseMs,
			)
			if (this.stopping) return 0
			await mapBounded(rows, this.options.concurrency, async (row) => {
				if (this.stopping) return
				const promise = this.process(row)
				this.inFlight.add(promise)
				this.notifyActivity()
				try {
					await promise
				} finally {
					this.inFlight.delete(promise)
					this.notifyActivity()
				}
			})
			if (!this.stopping) await this.maintainIfDue()
			return rows.length
		} finally {
			this.running = false
			this.notifyActivity()
		}
	}

	private async maintainIfDue(): Promise<void> {
		if (Date.now() - this.lastMaintenanceAt < this.options.maintenanceIntervalMs) return
		this.lastMaintenanceAt = Date.now()
		try {
			await this.options.persistence.runWebhookMaintenance({
				deliveredRetentionMs: this.options.deliveredRetentionMs,
				deadLetterRetentionMs: this.options.deadLetterRetentionMs,
			})
		} catch {
			logger.error('[delivery] maintenance failed')
		}
	}

	private recordDeliveryAudit(audit: DeliveryAuditEvent): void {
		if (this.stopping) return
		const task = persistDeliveryAudit(audit)
		this.auditTasks.add(task)
		this.notifyActivity()
		void task.finally(() => {
			this.auditTasks.delete(task)
			this.notifyActivity()
		})
	}

	private async process(row: ClaimedWebhookDelivery): Promise<void> {
		if (this.stopping) return
		let current: CurrentWebhookSubscription | null
		try {
			current = await this.options.persistence.getCurrentWebhookSubscription(row.ownerDid, row.webhookRkey)
		} catch {
			if (!this.stopping) await this.retry(row, { kind: 'subscription_unavailable', transient: true })
			return
		}
		if (this.stopping) return
		if (!current || current.url !== row.targetUrl || current.fingerprint !== row.subscriptionFingerprint) {
			if (
				!this.stopping &&
				(await this.options.persistence.cancelWebhookDeliveryForSubscriptionChange(row.deliveryId, row.leaseToken))
			) {
				const audit = auditFromPayload(row, 'failed')
				this.recordDeliveryAudit(audit)
			}
			return
		}

		let secret: string | undefined
		try {
			if (current.signingMode === 'secret_id') {
				const token = current.secretId
					? await this.options.persistence.getWebhookSecretToken(row.ownerDid, current.secretId)
					: null
				if (!token) throw new Error('secret unavailable')
				secret = token
			} else if (current.signingMode === 'record_secret') {
				const token = await this.options.persistence.getWebhookInlineSecret(row.ownerDid, row.webhookRkey)
				if (!token) throw new Error('secret unavailable')
				secret = token
			}
		} catch {
			if (!this.stopping) await this.retry(row, { kind: 'secret_unavailable', transient: true })
			return
		}
		if (this.stopping) return

		const lease = new DeliveryLeaseHeartbeat(
			row,
			this.options.leaseMs,
			this.options.persistence.renewWebhookDeliveryLease,
		)
		this.activeLeases.add(lease)
		try {
			// A DB timeout/lost lease before this point means do not send at all.
			if (!(await lease.acquire()) || this.stopping || lease.signal.aborted) return
			lease.start()
			if (this.stopping || lease.signal.aborted) return
			try {
				const result = await postDelivery(row, secret, this.options, lease.signal)
				if (this.stopping || lease.signal.aborted) return
				if (result.status >= 200 && result.status < 300) {
					if (
						await this.options.persistence.markWebhookDeliverySucceeded(row.deliveryId, row.leaseToken, result.status)
					) {
						const audit = auditFromPayload(row, 'ok')
						this.recordDeliveryAudit(audit)
					}
					return
				}
				await this.retry(row, classifyHttpStatus(result.status, result.retryAfterMs))
			} catch (error) {
				if (!this.stopping && !lease.signal.aborted) await this.retry(row, failureFromError(error))
			}
		} finally {
			await lease.stopAndDrain()
			this.activeLeases.delete(lease)
			this.notifyActivity()
		}
	}

	private async retry(row: ClaimedWebhookDelivery, failure: DeliveryFailure): Promise<void> {
		if (this.stopping) return
		const attemptNumber = row.attemptCount + 1
		const deadLetter = !failure.transient || attemptNumber >= this.options.maxAttempts
		const delay =
			failure.retryAfterMs === undefined
				? retryDelayMs(attemptNumber, this.options)
				: Math.min(this.options.retryMaxMs, failure.retryAfterMs)
		if (this.stopping) return
		const updated = await this.options.persistence.rescheduleWebhookDelivery(row.deliveryId, row.leaseToken, {
			nextAttemptAt: new Date(Date.now() + (deadLetter ? 0 : delay)).toISOString(),
			errorKind: failure.kind,
			httpStatus: failure.httpStatus,
			deadLetter,
		})
		if (updated && deadLetter && !this.stopping) {
			const audit = auditFromPayload(row, 'dead_letter')
			this.recordDeliveryAudit(audit)
		}
	}

	private abortActiveAttempts(): void {
		for (const lease of this.activeLeases) lease.abort()
	}

	/** Stop admission, grace-drain, then abort pinned HTTP attempts and heartbeat refreshes. */
	async stop(timeoutMs = this.options.requestTimeoutMs + 5_000): Promise<boolean> {
		this.stopping = true
		this.started = false
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		const timeout = boundedOption(timeoutMs, this.options.requestTimeoutMs + 5_000, 1, 10 * 60_000)
		const deadline = Date.now() + timeout
		// Reserve a bounded cleanup interval even for a short caller deadline.
		const cleanupBudget = Math.min(1_000, Math.max(25, Math.floor(timeout / 4)))
		const graceful = await this.waitForShutdownWork(Math.max(Date.now(), deadline - cleanupBudget))
		if (graceful) return true

		this.abortActiveAttempts()
		// Processes await stopAndDrain in their finally block, so a true result means
		// no heartbeat callback or pinned HTTP attempt remains before DB/Redis close.
		return this.waitForShutdownWork(deadline)
	}

	/** Graceful public drain; unlike stop it never aborts a healthy delivery. */
	async drain(timeoutMs = this.options.requestTimeoutMs + 5_000): Promise<boolean> {
		const deadline = Date.now() + boundedOption(timeoutMs, this.options.requestTimeoutMs + 5_000, 1, 10 * 60_000)
		return this.waitForShutdownWork(deadline)
	}
}

let defaultWorker: WebhookDeliveryWorker | undefined

export function startWebhookDeliveryWorker(options: WebhookDeliveryWorkerOptions = {}): WebhookDeliveryWorker {
	if (!defaultWorker) defaultWorker = new WebhookDeliveryWorker(options)
	defaultWorker.start()
	return defaultWorker
}

export async function stopWebhookDeliveryWorker(timeoutMs?: number): Promise<boolean> {
	if (!defaultWorker) return true
	const worker = defaultWorker
	defaultWorker = undefined
	return worker.stop(timeoutMs)
}

export async function drainWebhookDeliveryWorker(timeoutMs?: number): Promise<boolean> {
	return defaultWorker ? defaultWorker.drain(timeoutMs) : true
}
