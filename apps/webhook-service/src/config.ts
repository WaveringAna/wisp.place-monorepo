import {
	MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS,
	MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES,
	MAX_JETSTREAM_WANTED_DIDS,
} from './lib/admission'

const DEFAULT_JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe'
const DEFAULT_HEALTH_HOST = '127.0.0.1'

export interface WebhookServiceConfig {
	readonly production: boolean
	readonly allowInsecureDevelopment: boolean
	readonly databaseUrl?: string
	readonly jetstreamUrl: string
	readonly healthHost: string
	readonly healthPort: number
	readonly deliveryTimeoutMs: number
	readonly deliveryMaxRetries: number
	readonly redisUrl?: string
	readonly webhookEventsChannel: string
	readonly webhookCacheMax: number
	readonly webhookCacheTtlMs: number
	readonly intakeQueueMax: number
	readonly intakeBatchMax: number
	readonly intakeEventMaxBytes: number
	readonly intakeRecordKeyMax: number
	readonly registryActiveSubscriptionsMax: number
	readonly registryOwnerActiveRecordsMax: number
	readonly registryDirectScopeDidsMax: number
	readonly registryBacklinkScopeDidsMax: number
	readonly registrySubscriptionUrlBytesMax: number
	readonly jetstreamReconnectMinMs: number
	readonly jetstreamReconnectMaxMs: number
	readonly jetstreamReconnectMaxExponent: number
	readonly redisReconnectMinMs: number
	readonly redisReconnectMaxMs: number
	readonly redisReconnectMaxAttempts: number
	readonly redisPublishTimeoutMs: number
	readonly redisPublishMaxInFlight: number
	readonly initialBackfillRetryMinMs: number
	readonly initialBackfillRetryMaxMs: number
	readonly initialBackfillRetryMaxExponent: number
	readonly shutdownTimeoutMs: number
}

type Environment = Record<string, string | undefined>

function fail(name: string, message: string): never {
	throw new Error(`Invalid ${name}: ${message}`)
}

function integer(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || value === '') return fallback
	if (!/^(?:0|[1-9]\d*)$/.test(value)) fail(name, `must be an integer between ${min} and ${max}`)
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		fail(name, `must be an integer between ${min} and ${max}`)
	}
	return parsed
}

function boundedString(name: string, value: string | undefined, fallback: string, maxLength: number): string {
	const result = value === undefined || value === '' ? fallback : value
	if (result.length > maxLength) fail(name, `must be at most ${maxLength} characters`)
	return result
}

function parseUrl(
	name: string,
	value: string | undefined,
	fallback: string | undefined,
	allowedProtocols: readonly string[],
	production: boolean,
): string | undefined {
	if (value === undefined || value === '') {
		if (fallback === undefined) return undefined
		value = fallback
	}
	if (value.length > 2048) fail(name, 'must be at most 2048 characters')

	let url: URL
	try {
		url = new URL(value)
	} catch {
		fail(name, 'must be an absolute URL')
	}
	if (!allowedProtocols.includes(url.protocol)) fail(name, `must use ${allowedProtocols.join(' or ')}`)
	if (url.username || url.password) {
		// Redis credentials are intentionally handled below. Relay URLs never need them.
		if (name !== 'REDIS_URL' && name !== 'DATABASE_URL') fail(name, 'must not contain credentials')
	}
	if (url.hash) fail(name, 'must not contain a fragment')
	if (name === 'JETSTREAM_URL' && url.search) fail(name, 'must not contain query parameters')
	if (!url.hostname || url.hostname.length > 253) fail(name, 'has an invalid hostname')
	if (production && url.protocol === 'ws:') fail(name, 'must use wss in production')
	return url.toString()
}

function healthHost(value: string | undefined): string {
	const host = boundedString('HEALTH_HOST', value, DEFAULT_HEALTH_HOST, 64)
	// Health is the only listener. Bind only a literal loopback or an explicit
	// unspecified address for container orchestration; never an arbitrary interface name.
	if (host !== '127.0.0.1' && host !== '::1' && host !== '0.0.0.0' && host !== '::') {
		fail('HEALTH_HOST', 'must be 127.0.0.1, ::1, 0.0.0.0, or ::')
	}
	return host
}

function channel(value: string | undefined): string {
	const result = boundedString('WEBHOOK_EVENTS_CHANNEL', value, 'webhook:events', 128)
	if (!/^[A-Za-z0-9:_-]{1,128}$/.test(result)) {
		fail('WEBHOOK_EVENTS_CHANNEL', 'contains unsupported characters')
	}
	return result
}

/** Parse configuration without reading global process state. This is useful for startup tests. */
export function parseConfig(env: Environment = process.env): WebhookServiceConfig {
	const explicitlyDevelopment = env.NODE_ENV === 'development' || env.NODE_ENV === 'test'
	if (env.WEBHOOK_ALLOW_INSECURE_DEV !== undefined && env.WEBHOOK_ALLOW_INSECURE_DEV !== '1') {
		fail('WEBHOOK_ALLOW_INSECURE_DEV', 'must be exactly 1 when set')
	}
	const allowInsecureDevelopment = explicitlyDevelopment && env.WEBHOOK_ALLOW_INSECURE_DEV === '1'
	// Unknown/missing NODE_ENV is intentionally production-safe rather than development.
	const production = !allowInsecureDevelopment

	const jetstreamUrl = parseUrl('JETSTREAM_URL', env.JETSTREAM_URL, DEFAULT_JETSTREAM_URL, ['wss:', 'ws:'], production)
	if (!jetstreamUrl) fail('JETSTREAM_URL', 'is required')
	const parsedJetstream = new URL(jetstreamUrl)
	if (parsedJetstream.protocol === 'ws:') {
		if (!allowInsecureDevelopment || !['127.0.0.1', '[::1]', 'localhost'].includes(parsedJetstream.hostname)) {
			fail('JETSTREAM_URL', 'ws is allowed only for explicit loopback development')
		}
	}

	const databaseUrl = parseUrl('DATABASE_URL', env.DATABASE_URL, undefined, ['postgres:', 'postgresql:'], false)
	if (!databaseUrl && !allowInsecureDevelopment)
		fail('DATABASE_URL', 'is required outside explicit insecure development')

	const redisUrl = parseUrl('REDIS_URL', env.REDIS_URL, undefined, ['redis:', 'rediss:'], false)
	if (redisUrl) {
		const parsed = new URL(redisUrl)
		if (parsed.pathname && !/^\/(?:[0-9]|1[0-5])?$/.test(parsed.pathname)) {
			fail('REDIS_URL', 'database path must be between 0 and 15')
		}
	}

	const jetstreamReconnectMinMs = integer(
		'JETSTREAM_RECONNECT_MIN_MS',
		env.JETSTREAM_RECONNECT_MIN_MS,
		1_000,
		100,
		60_000,
	)
	const jetstreamReconnectMaxMs = integer(
		'JETSTREAM_RECONNECT_MAX_MS',
		env.JETSTREAM_RECONNECT_MAX_MS,
		300_000,
		1_000,
		300_000,
	)
	const redisReconnectMinMs = integer('REDIS_RECONNECT_MIN_MS', env.REDIS_RECONNECT_MIN_MS, 1_000, 100, 60_000)
	const redisReconnectMaxMs = integer('REDIS_RECONNECT_MAX_MS', env.REDIS_RECONNECT_MAX_MS, 30_000, 1_000, 300_000)
	const initialBackfillRetryMinMs = integer(
		'INITIAL_BACKFILL_RETRY_MIN_MS',
		env.INITIAL_BACKFILL_RETRY_MIN_MS,
		1_000,
		100,
		60_000,
	)
	const initialBackfillRetryMaxMs = integer(
		'INITIAL_BACKFILL_RETRY_MAX_MS',
		env.INITIAL_BACKFILL_RETRY_MAX_MS,
		60_000,
		1_000,
		300_000,
	)
	const registrySubscriptionUrlBytesMax = integer(
		'REGISTRY_SUBSCRIPTION_URL_BYTES_MAX',
		env.REGISTRY_SUBSCRIPTION_URL_BYTES_MAX,
		8_192,
		1_024,
		MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES,
	)
	if (jetstreamReconnectMinMs > jetstreamReconnectMaxMs)
		fail('JETSTREAM_RECONNECT_MAX_MS', 'must be at least JETSTREAM_RECONNECT_MIN_MS')
	if (redisReconnectMinMs > redisReconnectMaxMs)
		fail('REDIS_RECONNECT_MAX_MS', 'must be at least REDIS_RECONNECT_MIN_MS')
	if (initialBackfillRetryMinMs > initialBackfillRetryMaxMs)
		fail('INITIAL_BACKFILL_RETRY_MAX_MS', 'must be at least INITIAL_BACKFILL_RETRY_MIN_MS')
	if (registrySubscriptionUrlBytesMax < new TextEncoder().encode(new URL(jetstreamUrl).toString()).byteLength + 25) {
		fail('REGISTRY_SUBSCRIPTION_URL_BYTES_MAX', 'is too small for the relay URL')
	}

	return Object.freeze({
		production,
		allowInsecureDevelopment,
		databaseUrl,
		jetstreamUrl,
		healthHost: healthHost(env.HEALTH_HOST),
		healthPort: integer('HEALTH_PORT', env.HEALTH_PORT, 3003, 1, 65_535),
		deliveryTimeoutMs: integer('DELIVERY_TIMEOUT_MS', env.DELIVERY_TIMEOUT_MS, 10_000, 100, 60_000),
		deliveryMaxRetries: integer('DELIVERY_MAX_RETRIES', env.DELIVERY_MAX_RETRIES, 3, 1, 10),
		redisUrl,
		webhookEventsChannel: channel(env.WEBHOOK_EVENTS_CHANNEL),
		webhookCacheMax: integer('WEBHOOK_CACHE_MAX', env.WEBHOOK_CACHE_MAX, 1_000, 1, 10_000),
		webhookCacheTtlMs: integer('WEBHOOK_CACHE_TTL_MS', env.WEBHOOK_CACHE_TTL_MS, 60_000, 1_000, 3_600_000),
		intakeQueueMax: integer('WEBHOOK_INTAKE_QUEUE_MAX', env.WEBHOOK_INTAKE_QUEUE_MAX, 512, 1, 10_000),
		intakeBatchMax: integer('WEBHOOK_INTAKE_BATCH_MAX', env.WEBHOOK_INTAKE_BATCH_MAX, 128, 1, 1_000),
		intakeEventMaxBytes: integer(
			'WEBHOOK_INTAKE_EVENT_MAX_BYTES',
			env.WEBHOOK_INTAKE_EVENT_MAX_BYTES,
			1_048_576,
			1_024,
			8_388_608,
		),
		intakeRecordKeyMax: integer('WEBHOOK_INTAKE_RECORD_KEY_MAX', env.WEBHOOK_INTAKE_RECORD_KEY_MAX, 2_048, 1, 20_000),
		registryActiveSubscriptionsMax: integer(
			'REGISTRY_ACTIVE_SUBSCRIPTIONS_MAX',
			env.REGISTRY_ACTIVE_SUBSCRIPTIONS_MAX,
			MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS,
			1,
			MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS,
		),
		registryOwnerActiveRecordsMax: integer(
			'REGISTRY_OWNER_ACTIVE_RECORDS_MAX',
			env.REGISTRY_OWNER_ACTIVE_RECORDS_MAX,
			100,
			1,
			10_000,
		),
		registryDirectScopeDidsMax: integer(
			'REGISTRY_DIRECT_SCOPE_DIDS_MAX',
			env.REGISTRY_DIRECT_SCOPE_DIDS_MAX,
			2_048,
			1,
			MAX_JETSTREAM_WANTED_DIDS,
		),
		registryBacklinkScopeDidsMax: integer(
			'REGISTRY_BACKLINK_SCOPE_DIDS_MAX',
			env.REGISTRY_BACKLINK_SCOPE_DIDS_MAX,
			1_024,
			1,
			10_000,
		),
		registrySubscriptionUrlBytesMax,
		jetstreamReconnectMinMs,
		jetstreamReconnectMaxMs,
		jetstreamReconnectMaxExponent: integer(
			'JETSTREAM_RECONNECT_MAX_EXPONENT',
			env.JETSTREAM_RECONNECT_MAX_EXPONENT,
			8,
			0,
			16,
		),
		redisReconnectMinMs,
		redisReconnectMaxMs,
		redisReconnectMaxAttempts: integer('REDIS_RECONNECT_MAX_ATTEMPTS', env.REDIS_RECONNECT_MAX_ATTEMPTS, 10, 0, 1_000),
		redisPublishTimeoutMs: integer('REDIS_PUBLISH_TIMEOUT_MS', env.REDIS_PUBLISH_TIMEOUT_MS, 1_000, 50, 5_000),
		redisPublishMaxInFlight: integer('REDIS_PUBLISH_MAX_IN_FLIGHT', env.REDIS_PUBLISH_MAX_IN_FLIGHT, 4, 1, 16),
		initialBackfillRetryMinMs,
		initialBackfillRetryMaxMs,
		initialBackfillRetryMaxExponent: integer(
			'INITIAL_BACKFILL_RETRY_MAX_EXPONENT',
			env.INITIAL_BACKFILL_RETRY_MAX_EXPONENT,
			8,
			0,
			16,
		),
		shutdownTimeoutMs: integer('SHUTDOWN_TIMEOUT_MS', env.SHUTDOWN_TIMEOUT_MS, 30_000, 1_000, 120_000),
	})
}

/** Configuration is evaluated once, before network listeners are created. */
export const config = parseConfig()
