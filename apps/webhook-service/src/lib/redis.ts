import { createLogger } from '@wispplace/observability'
import { RedisClient } from 'bun'
import { config } from '../config'

const logger = createLogger('webhook-service:redis')

export interface WebhookEvent {
	ownerDid: string
	rkey: string
	url: string
	eventKind: 'create' | 'update' | 'delete'
	eventDid: string
	eventCollection: string
	eventRkey: string
	cid?: string
	deliveredAt: string
	status: 'ok' | 'failed'
}

export interface RedisPublishResult {
	readonly published: boolean
	readonly dropped: boolean
}

let publisher: RedisClient | null = null
let connected = false
let closing = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let loggedMissingRedis = false
let dropped = 0
let inFlight = 0
let lastFailureLogAt = 0
const activePublishes = new Set<Promise<unknown>>()

function incrementDropped(): void {
	dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1)
}

function safeLog(message: string): void {
	const now = Date.now()
	if (now - lastFailureLogAt < 60_000) return
	lastFailureLogAt = now
	logger.warn(message)
}

function validText(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !hasControlCharacter(value)
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		if ((value.charCodeAt(index) || 0) < 32) return true
	}
	return false
}

function validEvent(event: WebhookEvent): boolean {
	return (
		validText(event.ownerDid, 2_048) &&
		validText(event.rkey, 512) &&
		validText(event.url, 2_048) &&
		(event.eventKind === 'create' || event.eventKind === 'update' || event.eventKind === 'delete') &&
		validText(event.eventDid, 2_048) &&
		validText(event.eventCollection, 253) &&
		validText(event.eventRkey, 512) &&
		(event.cid === undefined || validText(event.cid, 512)) &&
		validText(event.deliveredAt, 128) &&
		(event.status === 'ok' || event.status === 'failed')
	)
}

function closeClient(client: RedisClient | null): void {
	if (!client) return
	try {
		client.close()
	} catch {
		// Closing is best-effort and must not expose a Redis error.
	}
}

function scheduleReconnect(): void {
	if (closing || !config.redisUrl || reconnectTimer || publisher) return
	if (reconnectAttempts >= config.redisReconnectMaxAttempts) {
		safeLog('[Redis] publisher reconnect limit reached')
		return
	}
	reconnectAttempts++
	const exponent = Math.min(reconnectAttempts - 1, 12)
	const ceiling = Math.min(config.redisReconnectMaxMs, config.redisReconnectMinMs * 2 ** exponent)
	const delay = Math.max(1, Math.floor(Math.random() * ceiling))
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null
		void createPublisher()
	}, delay)
}

async function createPublisher(): Promise<void> {
	if (closing || !config.redisUrl || publisher) return
	try {
		const client = new RedisClient(config.redisUrl)
		publisher = client
		connected = false
		client.onconnect = () => {
			if (publisher !== client || closing) return
			connected = true
			reconnectAttempts = 0
			logger.info('[Redis] publisher connected')
		}
		client.onclose = () => {
			if (publisher !== client) return
			publisher = null
			connected = false
			if (!closing) {
				safeLog('[Redis] publisher disconnected')
				scheduleReconnect()
			}
		}
	} catch {
		connected = false
		safeLog('[Redis] publisher connection failed')
		scheduleReconnect()
	}
}

async function availablePublisher(): Promise<RedisClient | null> {
	if (!config.redisUrl) {
		if (!loggedMissingRedis) {
			loggedMissingRedis = true
			logger.warn('[Redis] REDIS_URL not set; event publishing disabled')
		}
		return null
	}
	if (closing) return null
	if (publisher && connected) return publisher
	if (!publisher && !reconnectTimer) void createPublisher()
	return null
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([
		operation,
		new Promise<T>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Redis publish timed out')), timeoutMs)
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer)
	})
}

/**
 * Publish delivery audit metadata without buffering disconnected work. Redis is
 * never part of webhook delivery/cursor correctness, so callers receive a bounded
 * dropped result instead of an unbounded outage queue.
 */
export async function publishWebhookEvent(event: WebhookEvent): Promise<RedisPublishResult> {
	if (!validEvent(event)) {
		incrementDropped()
		safeLog('[Redis] refusing invalid delivery event')
		return { published: false, dropped: true }
	}
	const body = JSON.stringify(event)
	if (Buffer.byteLength(body) > 8 * 1_024) {
		incrementDropped()
		safeLog('[Redis] refusing oversized delivery event')
		return { published: false, dropped: true }
	}
	const client = await availablePublisher()
	if (!client || inFlight >= config.redisPublishMaxInFlight) {
		incrementDropped()
		return { published: false, dropped: true }
	}

	inFlight++
	const operation = Promise.resolve(client.publish(config.webhookEventsChannel, body))
	const tracked = operation.finally(() => {
		inFlight--
		activePublishes.delete(tracked)
	})
	activePublishes.add(tracked)
	try {
		await withTimeout(tracked, config.redisPublishTimeoutMs)
		return { published: true, dropped: false }
	} catch {
		incrementDropped()
		safeLog('[Redis] delivery event publish failed')
		if (publisher === client) {
			publisher = null
			connected = false
		}
		closeClient(client)
		scheduleReconnect()
		return { published: false, dropped: true }
	}
}

export function getRedisPublisherHealth(): {
	configured: boolean
	connected: boolean
	closing: boolean
	dropped: number
	inFlight: number
} {
	return { configured: Boolean(config.redisUrl), connected, closing, dropped, inFlight }
}

export async function closeRedisPublisher(): Promise<void> {
	closing = true
	if (reconnectTimer) clearTimeout(reconnectTimer)
	reconnectTimer = null
	const client = publisher
	publisher = null
	connected = false
	closeClient(client)
	// Do not await timed-out network operations forever. Their semaphore slots are
	// bounded and the client close causes normal implementations to reject them.
	void Promise.allSettled([...activePublishes])
}

/** Test-only reset that always closes the previous client before dropping state. */
export function resetRedisPublisherForTests(): void {
	if (reconnectTimer) clearTimeout(reconnectTimer)
	reconnectTimer = null
	const client = publisher
	publisher = null
	connected = false
	closing = false
	reconnectAttempts = 0
	loggedMissingRedis = false
	dropped = 0
	lastFailureLogAt = 0
	closeClient(client)
}
