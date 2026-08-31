/**
 * Environment configuration for firehose-service.
 *
 * Configuration is resolved once at startup. Validation errors intentionally do
 * not echo raw values because endpoint URLs can contain credentials.
 */

export type ConfigEnv = Readonly<Record<string, string | undefined>>

export interface FirehoseConfig {
	// Database
	databaseUrl: string

	// Firehose
	firehoseService: string
	firehoseServiceSecondary: string | undefined
	firehoseMaxConcurrency: number
	firehoseMaxPendingEvents: number
	firehoseDrainGraceMs: number
	plcDirectoryUrl: string | undefined

	// S3 storage (write destination)
	s3Bucket: string
	s3Region: string
	s3Endpoint: string | undefined
	s3ForcePathStyle: boolean
	s3Prefix: string
	allowDiskStorage: boolean
	awsAccessKeyId: string | undefined
	awsSecretAccessKey: string | undefined

	// Health check server
	healthPort: number

	// Redis revalidation queue
	redisUrl: string | undefined
	revalidateStream: string
	revalidateGroup: string
	revalidateStreamMaxLen: number
	revalidateDedupeTtlSeconds: number
	/** Stream receiving poison messages after bounded revalidation attempts. */
	revalidateDlqStream: string
	revalidateDlqStreamMaxLen: number
	cacheInvalidationStream: string
	cacheInvalidationStreamMaxLen: number

	// Leader election and the independent OS-process supervisor
	leaderElection: boolean
	leadershipSupervisorEnabled: boolean
	supervisorPath: string | undefined
	leaderTtlMs: number
	leaderRenewIntervalMs: number
	leaderPollIntervalMs: number
	cursorSaveIntervalMs: number

	// Mode
	isDbFillOnly: boolean
	isBackfill: boolean
	backfillConcurrency: number
	hydrantUrl: string | undefined
}

const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/wisp'
const DEFAULT_FIREHOSE_SERVICE = 'wss://bsky.network'
const DEFAULT_HEALTH_PORT = 3001
const DEFAULT_REVALIDATE_STREAM = 'wisp:revalidate'
const DEFAULT_REVALIDATE_GROUP = 'firehose-service'
const DEFAULT_REVALIDATE_DLQ_STREAM = 'wisp:revalidate:dlq'
const DEFAULT_CACHE_INVALIDATION_STREAM = 'wisp:cache-invalidate-stream'
const DEFAULT_LEADER_TTL_MS = 30_000
const DEFAULT_LEADER_RENEW_INTERVAL_MS = 10_000
const DEFAULT_LEADER_POLL_INTERVAL_MS = 5_000
const DEFAULT_CURSOR_SAVE_INTERVAL_MS = 5_000

const STREAM_NAME_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/
const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/
const S3_BUCKET_PATTERN =
	/^(?=.{3,63}$)(?![0-9]+(?:\.[0-9]+){3}$)(?!.*\.\.)(?!.*[.-]$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const S3_REGION_PATTERN = /^[A-Za-z0-9-]{1,64}$/

function hasUnsafeConfigText(value: string, forbidBackslash = false): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0
		return (forbidBackslash && character === '\\') || codePoint <= 0x1f || codePoint === 0x7f || character.trim() === ''
	})
}

function resolveBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined || !INTEGER_PATTERN.test(value)) return fallback
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback
	return parsed
}

function resolveStrictBoolean(value: string | undefined, fallback: boolean, field: string): boolean {
	if (value === undefined) return fallback
	if (value === 'true') return true
	if (value === 'false') return false
	throw new Error(`Invalid ${field}`)
}

function validateS3Bucket(value: string | undefined): string {
	if (value === undefined || value === '') return ''
	if (!S3_BUCKET_PATTERN.test(value)) throw new Error('Invalid S3_BUCKET')
	return value
}

function validateS3Region(value: string | undefined): string {
	const region = value ?? 'us-east-1'
	if (!S3_REGION_PATTERN.test(region)) throw new Error('Invalid S3_REGION')
	return region
}

function validateS3Prefix(value: string | undefined): string {
	const prefix = value ?? 'sites/'
	const segments = prefix.split('/')
	if (
		prefix.length > 512 ||
		prefix.startsWith('/') ||
		hasUnsafeConfigText(prefix, true) ||
		segments.some((segment) => segment === '.' || segment === '..')
	) {
		throw new Error('Invalid S3_PREFIX')
	}
	return prefix
}

function validateS3Credentials(accessKeyId: string | undefined, secretAccessKey: string | undefined): void {
	const hasAccessKey = Boolean(accessKeyId)
	const hasSecretKey = Boolean(secretAccessKey)
	if (hasAccessKey !== hasSecretKey) {
		throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together')
	}
	if ((accessKeyId && hasUnsafeConfigText(accessKeyId)) || (secretAccessKey && hasUnsafeConfigText(secretAccessKey))) {
		throw new Error('Invalid AWS credentials')
	}
}

function requireBoundedName(value: string | undefined, fallback: string, field: string): string {
	const result = value ?? fallback
	if (!STREAM_NAME_PATTERN.test(result)) throw new Error(`Invalid ${field}`)
	return result
}

function parseUrl(value: string, field: string): URL {
	try {
		return new URL(value)
	} catch {
		throw new Error(`Invalid ${field}`)
	}
}

function hasForbiddenUrlParts(url: URL): boolean {
	return Boolean(url.username || url.password || url.search || url.hash)
}

function isLocalDevelopmentHost(hostname: string): boolean {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '::1' ||
		hostname === '[::1]' ||
		hostname.endsWith('.localhost')
	)
}

function validateRelayUrl(value: string, field: string, production: boolean): string {
	const url = parseUrl(value, field)
	if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !url.hostname || hasForbiddenUrlParts(url)) {
		throw new Error(`Invalid ${field}`)
	}
	if (production && url.protocol !== 'wss:') throw new Error(`Invalid ${field}`)
	return value
}

function validateSecureHttpUrl(value: string | undefined, field: string, production: boolean): string | undefined {
	if (!value) return undefined
	const url = parseUrl(value, field)
	const allowLocalHttp = !production && url.protocol === 'http:' && isLocalDevelopmentHost(url.hostname)
	if ((!allowLocalHttp && url.protocol !== 'https:') || !url.hostname || hasForbiddenUrlParts(url)) {
		throw new Error(`Invalid ${field}`)
	}
	return value
}

function validateRedisUrl(value: string | undefined): string | undefined {
	if (!value) return undefined
	const url = parseUrl(value, 'REDIS_URL')
	if ((url.protocol !== 'redis:' && url.protocol !== 'rediss:') || !url.hostname || url.search || url.hash) {
		throw new Error('Invalid REDIS_URL')
	}
	return value
}

function validateS3Endpoint(value: string | undefined, production: boolean): string | undefined {
	if (!value) return undefined
	const url = parseUrl(value, 'S3_ENDPOINT')
	const allowLocalHttp = !production && url.protocol === 'http:' && isLocalDevelopmentHost(url.hostname)
	if ((!allowLocalHttp && url.protocol !== 'https:') || !url.hostname || hasForbiddenUrlParts(url)) {
		throw new Error('Invalid S3_ENDPOINT')
	}
	return value
}

function validateDatabaseUrl(value: string, production: boolean): string {
	if (production && !value) throw new Error('DATABASE_URL is required in production')
	const url = parseUrl(value, 'DATABASE_URL')
	if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
		throw new Error('Invalid DATABASE_URL')
	}
	return value
}

interface EnvironmentContext {
	production: boolean
	developmentOrTest: boolean
}

type ResolvedStorageConfig = Pick<
	FirehoseConfig,
	| 's3Bucket'
	| 's3Region'
	| 's3Endpoint'
	| 's3ForcePathStyle'
	| 's3Prefix'
	| 'allowDiskStorage'
	| 'awsAccessKeyId'
	| 'awsSecretAccessKey'
>
type ResolvedLeaderConfig = Pick<
	FirehoseConfig,
	| 'leaderElection'
	| 'leadershipSupervisorEnabled'
	| 'supervisorPath'
	| 'leaderTtlMs'
	| 'leaderRenewIntervalMs'
	| 'leaderPollIntervalMs'
	| 'cursorSaveIntervalMs'
>
type ResolvedFirehoseConfig = Pick<
	FirehoseConfig,
	| 'firehoseService'
	| 'firehoseServiceSecondary'
	| 'firehoseMaxConcurrency'
	| 'firehoseMaxPendingEvents'
	| 'firehoseDrainGraceMs'
	| 'plcDirectoryUrl'
>
type ResolvedQueueConfig = Pick<
	FirehoseConfig,
	| 'redisUrl'
	| 'revalidateStream'
	| 'revalidateGroup'
	| 'revalidateStreamMaxLen'
	| 'revalidateDedupeTtlSeconds'
	| 'revalidateDlqStream'
	| 'revalidateDlqStreamMaxLen'
	| 'cacheInvalidationStream'
	| 'cacheInvalidationStreamMaxLen'
>
type ResolvedModeConfig = Pick<FirehoseConfig, 'isDbFillOnly' | 'isBackfill' | 'backfillConcurrency' | 'hydrantUrl'>

function resolveEnvironmentContext(env: ConfigEnv): EnvironmentContext {
	return {
		production: env.NODE_ENV === 'production',
		developmentOrTest: env.NODE_ENV === 'development' || env.NODE_ENV === 'test',
	}
}

function validateDiskStorageMode(allowDiskStorage: boolean, context: EnvironmentContext): void {
	if (allowDiskStorage && !context.developmentOrTest) {
		throw new Error('FIREHOSE_ALLOW_DISK_STORAGE is only allowed in development or test')
	}
}

function validateStoragePresence(
	s3Bucket: string,
	allowDiskStorage: boolean,
	s3Endpoint: string | undefined,
	awsAccessKeyId: string | undefined,
	awsSecretAccessKey: string | undefined,
): void {
	if (s3Bucket) return
	if (!allowDiskStorage) {
		throw new Error('S3_BUCKET is required unless FIREHOSE_ALLOW_DISK_STORAGE is enabled for development or test')
	}
	if (s3Endpoint || awsAccessKeyId || awsSecretAccessKey) {
		throw new Error('S3_BUCKET is required when S3 endpoint or credentials are configured')
	}
}

function resolveStorageConfig(env: ConfigEnv, context: EnvironmentContext): ResolvedStorageConfig {
	const allowDiskStorage = resolveStrictBoolean(
		env.FIREHOSE_ALLOW_DISK_STORAGE,
		env.NODE_ENV === 'test',
		'FIREHOSE_ALLOW_DISK_STORAGE',
	)
	validateDiskStorageMode(allowDiskStorage, context)

	const s3Bucket = validateS3Bucket(env.S3_BUCKET)
	const s3Region = validateS3Region(env.S3_REGION)
	const s3Endpoint = validateS3Endpoint(env.S3_ENDPOINT, context.production)
	const s3Prefix = validateS3Prefix(env.S3_PREFIX)
	const awsAccessKeyId = env.AWS_ACCESS_KEY_ID
	const awsSecretAccessKey = env.AWS_SECRET_ACCESS_KEY
	validateS3Credentials(awsAccessKeyId, awsSecretAccessKey)
	validateStoragePresence(s3Bucket, allowDiskStorage, s3Endpoint, awsAccessKeyId, awsSecretAccessKey)

	return {
		s3Bucket,
		s3Region,
		s3Endpoint,
		s3ForcePathStyle: resolveStrictBoolean(env.S3_FORCE_PATH_STYLE, true, 'S3_FORCE_PATH_STYLE'),
		s3Prefix,
		allowDiskStorage,
		awsAccessKeyId,
		awsSecretAccessKey,
	}
}

function resolveLeaderRenewInterval(leaderTtlMs: number, configuredRenew: number): number {
	// Renew often enough to leave room for bounded Redis connect/command
	// latency and one or more transient failures. The lease deadline below is
	// independent of this value, so a malformed or overly large setting must
	// never make us wait most of the TTL before noticing a lost lease.
	const maximumSafeRenewInterval = Math.max(100, Math.floor(leaderTtlMs / 4))
	return Math.min(configuredRenew, maximumSafeRenewInterval)
}

function validateLeaderRedisRequirement(
	production: boolean,
	leaderElection: boolean,
	redisUrl: string | undefined,
): void {
	if (production && !leaderElection) throw new Error('LEADER_ELECTION must be enabled in production')
	if ((production || leaderElection) && !redisUrl) {
		throw new Error('REDIS_URL is required for durable firehose operation')
	}
}

function resolveLeaderConfig(env: ConfigEnv, production: boolean, redisUrl: string | undefined): ResolvedLeaderConfig {
	const leaderTtlMs = resolveBoundedInteger(env.LEADER_TTL_MS, DEFAULT_LEADER_TTL_MS, 1_000, 300_000)
	const configuredRenew = resolveBoundedInteger(
		env.LEADER_RENEW_INTERVAL_MS,
		DEFAULT_LEADER_RENEW_INTERVAL_MS,
		100,
		299_999,
	)
	const leaderElection = resolveStrictBoolean(env.LEADER_ELECTION, production, 'LEADER_ELECTION')
	validateLeaderRedisRequirement(production, leaderElection, redisUrl)
	const leadershipSupervisorEnabled = resolveStrictBoolean(
		env.LEADERSHIP_SUPERVISOR_ENABLED ?? env.FIREHOSE_SUPERVISOR_ENABLED ?? env.SUPERVISOR_ENABLED,
		leaderElection,
		'LEADERSHIP_SUPERVISOR_ENABLED',
	)
	if (production && leaderElection && !leadershipSupervisorEnabled) {
		throw new Error('LEADERSHIP_SUPERVISOR_ENABLED must be enabled in production')
	}
	const supervisorPath =
		env.FIREHOSE_SUPERVISOR_PATH || env.LEADERSHIP_SUPERVISOR_PATH || env.SUPERVISOR_PATH || undefined

	return {
		leaderElection,
		leadershipSupervisorEnabled,
		supervisorPath,
		leaderTtlMs,
		leaderRenewIntervalMs: resolveLeaderRenewInterval(leaderTtlMs, configuredRenew),
		leaderPollIntervalMs: resolveBoundedInteger(
			env.LEADER_POLL_INTERVAL_MS,
			DEFAULT_LEADER_POLL_INTERVAL_MS,
			100,
			60_000,
		),
		cursorSaveIntervalMs: resolveBoundedInteger(
			env.CURSOR_SAVE_INTERVAL_MS,
			DEFAULT_CURSOR_SAVE_INTERVAL_MS,
			100,
			300_000,
		),
	}
}

function resolveFirehoseConfig(env: ConfigEnv, production: boolean): ResolvedFirehoseConfig {
	const secondary = env.FIREHOSE_SERVICE_SECONDARY
	return {
		firehoseService: validateRelayUrl(env.FIREHOSE_SERVICE ?? DEFAULT_FIREHOSE_SERVICE, 'FIREHOSE_SERVICE', production),
		firehoseServiceSecondary: secondary
			? validateRelayUrl(secondary, 'FIREHOSE_SERVICE_SECONDARY', production)
			: undefined,
		firehoseMaxConcurrency: resolveBoundedInteger(env.FIREHOSE_MAX_CONCURRENCY, 5, 1, 20),
		firehoseMaxPendingEvents: resolveBoundedInteger(env.FIREHOSE_MAX_PENDING_EVENTS, 10_000, 1, 100_000),
		firehoseDrainGraceMs: resolveBoundedInteger(env.FIREHOSE_DRAIN_GRACE_MS, 30_000, 0, 300_000),
		plcDirectoryUrl: validateSecureHttpUrl(env.WISP_PLC_DIRECTORY_URL, 'WISP_PLC_DIRECTORY_URL', production),
	}
}

function resolveQueueConfig(env: ConfigEnv): ResolvedQueueConfig {
	return {
		redisUrl: validateRedisUrl(env.REDIS_URL),
		revalidateStream: requireBoundedName(
			env.WISP_REVALIDATE_STREAM,
			DEFAULT_REVALIDATE_STREAM,
			'WISP_REVALIDATE_STREAM',
		),
		revalidateGroup: requireBoundedName(env.WISP_REVALIDATE_GROUP, DEFAULT_REVALIDATE_GROUP, 'WISP_REVALIDATE_GROUP'),
		revalidateStreamMaxLen: resolveBoundedInteger(env.WISP_REVALIDATE_STREAM_MAXLEN, 10_000, 1, 1_000_000),
		revalidateDedupeTtlSeconds: resolveBoundedInteger(env.WISP_REVALIDATE_DEDUPE_TTL_SECONDS, 60, 1, 86_400),
		revalidateDlqStream: requireBoundedName(
			env.WISP_REVALIDATE_DLQ_STREAM,
			DEFAULT_REVALIDATE_DLQ_STREAM,
			'WISP_REVALIDATE_DLQ_STREAM',
		),
		revalidateDlqStreamMaxLen: resolveBoundedInteger(env.WISP_REVALIDATE_DLQ_STREAM_MAXLEN, 10_000, 1, 1_000_000),
		cacheInvalidationStream: requireBoundedName(
			env.WISP_CACHE_INVALIDATION_STREAM,
			DEFAULT_CACHE_INVALIDATION_STREAM,
			'WISP_CACHE_INVALIDATION_STREAM',
		),
		cacheInvalidationStreamMaxLen: resolveBoundedInteger(
			env.WISP_CACHE_INVALIDATION_STREAM_MAXLEN,
			10_000,
			1,
			1_000_000,
		),
	}
}

function resolveModeConfig(env: ConfigEnv, args: readonly string[], production: boolean): ResolvedModeConfig {
	const isDbFillOnly = args.includes('--db-fill-only') || env.DB_FILL_ONLY === 'true'
	return {
		isDbFillOnly,
		isBackfill: args.includes('--backfill') || isDbFillOnly || env.BACKFILL === 'true',
		backfillConcurrency: resolveBoundedInteger(env.BACKFILL_CONCURRENCY, 5, 1, 20),
		hydrantUrl: validateSecureHttpUrl(env.HYDRANT_URL, 'HYDRANT_URL', production),
	}
}

/**
 * Resolve configuration without reading global process state. This boundary is
 * exported for deterministic validation tests and never logs raw values.
 */
export function resolveConfig(env: ConfigEnv = {}, args: readonly string[] = []): FirehoseConfig {
	const context = resolveEnvironmentContext(env)
	const databaseUrl = validateDatabaseUrl(
		env.DATABASE_URL ?? (context.production ? '' : DEFAULT_DATABASE_URL),
		context.production,
	)
	const storage = resolveStorageConfig(env, context)
	const queue = resolveQueueConfig(env)
	const leader = resolveLeaderConfig(env, context.production, queue.redisUrl)
	const firehose = resolveFirehoseConfig(env, context.production)
	const mode = resolveModeConfig(env, args, context.production)

	return {
		databaseUrl,
		...firehose,
		...storage,
		healthPort: resolveBoundedInteger(env.HEALTH_PORT, DEFAULT_HEALTH_PORT, 1, 65_535),
		...queue,
		...leader,
		...mode,
	}
}

export const config = resolveConfig(process.env, process.argv)
