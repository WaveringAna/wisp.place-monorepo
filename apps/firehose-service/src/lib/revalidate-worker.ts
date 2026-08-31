import os from 'node:os'
import { SubfsExpansionError } from '@wispplace/atproto-utils'
import { createLogger } from '@wispplace/observability'
import { SafeFetchHttpError } from '@wispplace/safe-fetch'
import { DecompressionLimitError } from '@wispplace/tiered-storage'
import Redis from 'ioredis'
import { config } from '../config'
import {
	AuthoritativeSettingsRecordError,
	AuthoritativeSiteRecordError,
	FileLogicalSizeLimitError,
	fetchSettingsRecord,
	fetchSettingsRecordOutcome,
	fetchSiteRecord,
	fetchSiteRecordOutcome,
	handleSettingsDelete,
	handleSettingsUpdate,
	handleSiteCreateOrUpdate,
	handleSiteDelete,
	SiteBlobBackoffError,
	SiteLogicalQuotaExceededError,
} from './cache-writer'
import {
	isSettingsFailureRevalidationReason,
	isSiteDeleteTombstoneReason,
	SETTINGS_DELETE_FAILURE_REASON,
} from './revalidate-queue'
import {
	assertRevalidationActive,
	createRevalidationResourceContext,
	RevalidationDeadlineError,
	type RevalidationResourceContext,
	TransferBudgetExceededError,
} from './revalidate-resources'

export type { RevalidationResourceContext, TransferByteBudgetLike } from './revalidate-resources'
export {
	createRevalidationResourceContext,
	RevalidationDeadlineError,
	TransferBudgetExceededError,
	TransferByteBudget,
} from './revalidate-resources'

const logger = createLogger('firehose-service')
const consumerName = process.env.WISP_REVALIDATE_CONSUMER || `${os.hostname()}:${process.pid}`

const DEFAULT_BATCH_SIZE = 10
const MAX_BATCH_SIZE = 100
const DEFAULT_CLAIM_IDLE_MS = 60_000
const MIN_CLAIM_IDLE_MS = 1_000
const MAX_CLAIM_IDLE_MS = 60 * 60 * 1000
const DEFAULT_BLOCK_MS = 5_000
const MIN_BLOCK_MS = 1_000
const MAX_BLOCK_MS = 60_000
const DEFAULT_BLOCKING_GRACE_MS = 1_000
const MIN_BLOCKING_GRACE_MS = 100
const MAX_BLOCKING_GRACE_MS = 10_000
const MIN_SOCKET_TIMEOUT_EXTRA_MS = 1_000
const DEFAULT_SOCKET_TIMEOUT_EXTRA_MS = 10_000
const MAX_SOCKET_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_FAILURE_BACKOFF_SECONDS = 600
const MAX_FAILURE_BACKOFF_SECONDS = 24 * 60 * 60
const DEFAULT_RECONNECT_MIN_MS = 250
const DEFAULT_RECONNECT_MAX_MS = 30_000
const MAX_RECONNECT_MS = 5 * 60 * 1000

/** Strict poison-message/resource defaults. */
export const DEFAULT_REVALIDATE_MAX_ATTEMPTS = 3
export const DEFAULT_REVALIDATE_DEADLINE_MS = 5 * 60 * 1000
export const DEFAULT_REVALIDATE_TRANSFER_BUDGET_BYTES = 1024 * 1024 * 1024
export const DEFAULT_REVALIDATE_RETRY_BACKOFF_BASE_MS = 60_000
export const DEFAULT_REVALIDATE_RETRY_BACKOFF_MAX_MS = 15 * 60 * 1000
const MAX_REVALIDATE_ATTEMPTS = 20
const MAX_REVALIDATE_DEADLINE_MS = 30 * 60 * 1000
const MAX_REVALIDATE_TRANSFER_BUDGET_BYTES = 10 * 1024 * 1024 * 1024
const MAX_REVALIDATE_BACKOFF_MS = 60 * 60 * 1000

export interface RevalidateWorkerRuntimeConfig {
	batchSize: number
	claimIdleMs: number
	blockMs: number
	blockingGraceMs: number
	socketTimeoutMs: number
	failureBackoffSeconds: number
	reconnectMinMs: number
	reconnectMaxMs: number
	/** Maximum delivery attempts before quarantine. */
	maxAttempts?: number
	/** Per-message wall-clock deadline. */
	revalidationDeadlineMs?: number
	/** Shared inbound transfer-byte budget. */
	transferBudgetBytes?: number
	/** Capped exponential retry delay parameters. */
	retryBackoffBaseMs?: number
	retryBackoffMaxMs?: number
	/** Compatibility aliases for isolated callers. */
	wallDeadlineMs?: number
	maxTransferBytes?: number
	maxDeliveryAttempts?: number
	transferByteBudgetBytes?: number
	retryBaseMs?: number
	retryMaxMs?: number
}

export interface RevalidateWorkerRedisOptions {
	maxRetriesPerRequest: number
	enableReadyCheck: boolean
	blockingTimeout: number
	blockingTimeoutGrace: number
	socketTimeout: number
}

export type RevalidateWorkerRedisFactory = (redisUrl: string, options: RevalidateWorkerRedisOptions) => Redis

function parseBoundedPositiveInt(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function resolveRevalidateWorkerRuntimeConfig(
	environment: Record<string, string | undefined> = process.env,
): RevalidateWorkerRuntimeConfig {
	const batchSize = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_BATCH_SIZE,
		DEFAULT_BATCH_SIZE,
		1,
		MAX_BATCH_SIZE,
	)
	const claimIdleMs = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_CLAIM_IDLE_MS,
		DEFAULT_CLAIM_IDLE_MS,
		MIN_CLAIM_IDLE_MS,
		MAX_CLAIM_IDLE_MS,
	)
	const blockMs = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_BLOCK_MS,
		DEFAULT_BLOCK_MS,
		MIN_BLOCK_MS,
		MAX_BLOCK_MS,
	)
	const blockingGraceMs = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_BLOCKING_GRACE_MS,
		DEFAULT_BLOCKING_GRACE_MS,
		MIN_BLOCKING_GRACE_MS,
		MAX_BLOCKING_GRACE_MS,
	)
	const minimumSocketTimeoutMs = blockMs + blockingGraceMs + MIN_SOCKET_TIMEOUT_EXTRA_MS
	const socketTimeoutMs = Math.max(
		parseBoundedPositiveInt(
			environment.WISP_REVALIDATE_SOCKET_TIMEOUT_MS,
			blockMs + blockingGraceMs + DEFAULT_SOCKET_TIMEOUT_EXTRA_MS,
			1,
			MAX_SOCKET_TIMEOUT_MS,
		),
		minimumSocketTimeoutMs,
	)
	const failureBackoffSeconds = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_FAILURE_BACKOFF_SECONDS,
		DEFAULT_FAILURE_BACKOFF_SECONDS,
		1,
		MAX_FAILURE_BACKOFF_SECONDS,
	)
	const reconnectMinMs = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_RECONNECT_MIN_MS,
		DEFAULT_RECONNECT_MIN_MS,
		10,
		MAX_RECONNECT_MS,
	)
	const reconnectMaxMs = Math.max(
		reconnectMinMs,
		parseBoundedPositiveInt(
			environment.WISP_REVALIDATE_RECONNECT_MAX_MS,
			DEFAULT_RECONNECT_MAX_MS,
			10,
			MAX_RECONNECT_MS,
		),
	)
	const maxAttempts = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_MAX_ATTEMPTS ??
			environment.WISP_REVALIDATE_MAX_DELIVERIES ??
			environment.FIREHOSE_REVALIDATE_MAX_ATTEMPTS,
		DEFAULT_REVALIDATE_MAX_ATTEMPTS,
		1,
		MAX_REVALIDATE_ATTEMPTS,
	)
	const revalidationDeadlineMs = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_DEADLINE_MS ??
			environment.WISP_REVALIDATE_WALL_DEADLINE_MS ??
			environment.FIREHOSE_REVALIDATION_DEADLINE_MS,
		DEFAULT_REVALIDATE_DEADLINE_MS,
		1_000,
		MAX_REVALIDATE_DEADLINE_MS,
	)
	const transferBudgetBytes = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_TRANSFER_BUDGET_BYTES ??
			environment.WISP_REVALIDATE_TRANSFER_BUDGET ??
			environment.FIREHOSE_REVALIDATION_TRANSFER_BUDGET_BYTES,
		DEFAULT_REVALIDATE_TRANSFER_BUDGET_BYTES,
		1,
		MAX_REVALIDATE_TRANSFER_BUDGET_BYTES,
	)
	const retryBackoffBaseMs = parseBoundedPositiveInt(
		environment.WISP_REVALIDATE_RETRY_BACKOFF_BASE_MS ??
			environment.WISP_REVALIDATE_RETRY_BASE_MS ??
			environment.FIREHOSE_REVALIDATE_RETRY_BASE_MS,
		DEFAULT_REVALIDATE_RETRY_BACKOFF_BASE_MS,
		100,
		MAX_REVALIDATE_BACKOFF_MS,
	)
	const retryBackoffMaxMs = Math.max(
		retryBackoffBaseMs,
		parseBoundedPositiveInt(
			environment.WISP_REVALIDATE_RETRY_BACKOFF_MAX_MS ??
				environment.WISP_REVALIDATE_RETRY_MAX_MS ??
				environment.FIREHOSE_REVALIDATE_RETRY_MAX_MS,
			DEFAULT_REVALIDATE_RETRY_BACKOFF_MAX_MS,
			retryBackoffBaseMs,
			MAX_REVALIDATE_BACKOFF_MS,
		),
	)

	// Keep the legacy enumerable shape stable for existing callers while making
	// the strict policy available as ordinary properties. This also avoids
	// accidentally logging the new resource values as part of old diagnostics.
	const result: RevalidateWorkerRuntimeConfig = {
		batchSize,
		claimIdleMs,
		blockMs,
		blockingGraceMs,
		socketTimeoutMs,
		failureBackoffSeconds,
		reconnectMinMs,
		reconnectMaxMs,
	}
	Object.defineProperties(result, {
		maxAttempts: { value: maxAttempts, enumerable: false },
		revalidationDeadlineMs: { value: revalidationDeadlineMs, enumerable: false },
		transferBudgetBytes: { value: transferBudgetBytes, enumerable: false },
		retryBackoffBaseMs: { value: retryBackoffBaseMs, enumerable: false },
		retryBackoffMaxMs: { value: retryBackoffMaxMs, enumerable: false },
		// Friendly aliases accepted by older isolated test harnesses.
		wallDeadlineMs: { value: revalidationDeadlineMs, enumerable: false },
		maxTransferBytes: { value: transferBudgetBytes, enumerable: false },
		maxDeliveryAttempts: { value: maxAttempts, enumerable: false },
		transferByteBudgetBytes: { value: transferBudgetBytes, enumerable: false },
		retryBaseMs: { value: retryBackoffBaseMs, enumerable: false },
		retryMaxMs: { value: retryBackoffMaxMs, enumerable: false },
	})
	return result
}

export function createRevalidateWorkerRedisOptions(
	runtimeConfig: RevalidateWorkerRuntimeConfig,
): RevalidateWorkerRedisOptions {
	return {
		maxRetriesPerRequest: 2,
		enableReadyCheck: true,
		// A normal XREADGROUP BLOCK response lands before this client-side bound.
		// The grace lets ioredis resolve a half-open blocking command instead of
		// leaving the worker (and shutdown) hung forever.
		blockingTimeout: runtimeConfig.blockMs + runtimeConfig.blockingGraceMs,
		blockingTimeoutGrace: runtimeConfig.blockingGraceMs,
		socketTimeout: Math.max(
			runtimeConfig.socketTimeoutMs,
			runtimeConfig.blockMs + runtimeConfig.blockingGraceMs + MIN_SOCKET_TIMEOUT_EXTRA_MS,
		),
	}
}

const revalidateWorkerRuntimeConfig = resolveRevalidateWorkerRuntimeConfig()
const failureBackoffSeconds = revalidateWorkerRuntimeConfig.failureBackoffSeconds

interface RevalidatePolicyConfig {
	maxAttempts: number
	revalidationDeadlineMs: number
	transferBudgetBytes: number
	retryBackoffBaseMs: number
	retryBackoffMaxMs: number
}

function policyConfig(runtime: RevalidateWorkerRuntimeConfig): RevalidatePolicyConfig {
	const values = runtime as RevalidateWorkerRuntimeConfig & {
		wallDeadlineMs?: number
		maxTransferBytes?: number
		maxDeliveryAttempts?: number
		transferByteBudgetBytes?: number
		retryBaseMs?: number
		retryMaxMs?: number
	}
	const maxAttempts = values.maxAttempts ?? values.maxDeliveryAttempts ?? DEFAULT_REVALIDATE_MAX_ATTEMPTS
	const revalidationDeadlineMs =
		values.revalidationDeadlineMs ?? values.wallDeadlineMs ?? DEFAULT_REVALIDATE_DEADLINE_MS
	const transferBudgetBytes =
		values.transferBudgetBytes ??
		values.maxTransferBytes ??
		values.transferByteBudgetBytes ??
		DEFAULT_REVALIDATE_TRANSFER_BUDGET_BYTES
	const retryBackoffBaseMs = values.retryBackoffBaseMs ?? values.retryBaseMs ?? DEFAULT_REVALIDATE_RETRY_BACKOFF_BASE_MS
	const retryBackoffMaxMs = Math.max(
		values.retryBackoffMaxMs ?? values.retryMaxMs ?? DEFAULT_REVALIDATE_RETRY_BACKOFF_MAX_MS,
		retryBackoffBaseMs,
	)
	return { maxAttempts, revalidationDeadlineMs, transferBudgetBytes, retryBackoffBaseMs, retryBackoffMaxMs }
}

export function revalidateRetryBackoffMs(
	attempt: number,
	baseMs = DEFAULT_REVALIDATE_RETRY_BACKOFF_BASE_MS,
	maxMs = DEFAULT_REVALIDATE_RETRY_BACKOFF_MAX_MS,
): number {
	if (!Number.isSafeInteger(attempt) || attempt < 1)
		throw new RangeError('Revalidation attempt must be a positive safe integer')
	if (!Number.isSafeInteger(baseMs) || baseMs < 1 || !Number.isSafeInteger(maxMs) || maxMs < baseMs) {
		throw new RangeError('Revalidation retry backoff bounds are invalid')
	}
	return Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 30))
}

const defaultRedisClientFactory: RevalidateWorkerRedisFactory = (redisUrl, options) => new Redis(redisUrl, options)

let redis: Redis | null = null
let running = false
let loopPromise: Promise<void> | null = null
let cancelLoopRetryWait: (() => void) | null = null
let workerAbortController: AbortController | null = null
let workerGeneration = 0

function errorKind(error: unknown): string {
	if (error instanceof Error && error.name) return error.name
	return 'UnknownError'
}

function isActiveWorkerClient(client: Redis): boolean {
	return running && redis === client
}

function getFailureBackoffKey(did: string, rkey: string): string {
	return `revalidate:site:failure-backoff:${did}:${rkey}`
}

function getRetrySuppressionKey(id: string): string {
	return `revalidate:retry:${id}`
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

export interface RevalidateWorkerDependencies {
	fetchSettingsRecord: typeof fetchSettingsRecord
	fetchSettingsRecordOutcome?: typeof fetchSettingsRecordOutcome
	fetchSiteRecord: typeof fetchSiteRecord
	fetchSiteRecordOutcome?: typeof fetchSiteRecordOutcome
	handleSettingsDelete: typeof handleSettingsDelete
	handleSettingsUpdate: typeof handleSettingsUpdate
	handleSiteCreateOrUpdate: typeof handleSiteCreateOrUpdate
	handleSiteDelete: typeof handleSiteDelete
}

export interface RevalidateRedisPipeline {
	ttl(key: string): RevalidateRedisPipeline
	exec(): PromiseLike<unknown>
}

export interface RevalidateRedisClient {
	ttl(key: string): PromiseLike<number>
	/** Queue commands and execute them in one Redis round trip. */
	pipeline?(): RevalidateRedisPipeline
	/** Atomically XACK then XDEL for the sole documented consumer group. */
	eval(script: string, keyCount: number, ...args: string[]): PromiseLike<unknown>
	set(key: string, value: string, expirationMode: 'EX', ttlSeconds: number): PromiseLike<'OK' | null>
	/** Redis XPENDING exact-id lookup; unavailable only in minimal test seams. */
	xpending?(...args: (string | number)[]): PromiseLike<unknown>
}

export type RevalidationFailureClass = 'permanent' | 'transient'

export interface RevalidationFailureInfo {
	classification: RevalidationFailureClass
	code: string
}

/** Stable, bounded failure used for typed PDS outcomes. */
export class RevalidationProcessingError extends Error {
	constructor(
		readonly code: string,
		readonly classification: RevalidationFailureClass,
	) {
		super(`Revalidation failed: ${code}`)
		this.name = 'RevalidationProcessingError'
	}
}

const COMPLETE_REVALIDATION_SCRIPT = `
local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
if acknowledged ~= 1 then return {acknowledged, 0} end
local deleted = redis.call('XDEL', KEYS[1], ARGV[2])
return {acknowledged, deleted}
`

/**
 * Write the DLQ record before touching the source entry. Redis executes the
 * whole script atomically, so a successful XACK/XDEL can never precede the
 * quarantine write.
 */
export const QUARANTINE_REVALIDATION_SCRIPT = `
local dlqId = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[10], '*',
  'sourceId', ARGV[2],
  'did', ARGV[3],
  'rkey', ARGV[4],
  'reason', ARGV[5],
  'errorCode', ARGV[6],
  'error', ARGV[7],
  'classification', ARGV[8],
  'attempts', ARGV[9],
  'quarantinedAt', ARGV[11])
local acknowledged = redis.call('XACK', KEYS[1], ARGV[1], ARGV[2])
if acknowledged ~= 1 then return {acknowledged, dlqId, 0} end
local deleted = redis.call('XDEL', KEYS[1], ARGV[2])
return {acknowledged, dlqId, deleted}
`

// Legacy cleanup is deliberately much stricter than producer capacity: every
// consumer group must be entirely drained. XINFO, the safety checks, and XTRIM
// execute atomically, so a producer cannot add an entry between observing lag
// zero and trimming. Unknown or old groups fail closed instead of losing entries.
const TRIM_DRAINED_REVALIDATION_SCRIPT = `
local groups = redis.call('XINFO', 'GROUPS', KEYS[1])
local configuredFound = false
for _, group in ipairs(groups) do
  local name = nil
  local pending = nil
  local lag = nil
  for i = 1, #group, 2 do
    if group[i] == 'name' then name = group[i + 1] end
    if group[i] == 'pending' then pending = tonumber(group[i + 1]) end
    if group[i] == 'lag' then lag = tonumber(group[i + 1]) end
  end
  if not name or pending == nil or lag == nil then return 0 end
  if name == ARGV[1] then configuredFound = true end
  if pending ~= 0 or lag ~= 0 then return 0 end
end
if not configuredFound then return 0 end
return redis.call('XTRIM', KEYS[1], 'MAXLEN', '=', 0)
`

const defaultRevalidateWorkerDependencies: RevalidateWorkerDependencies = {
	fetchSettingsRecord,
	fetchSettingsRecordOutcome,
	fetchSiteRecord,
	fetchSiteRecordOutcome,
	handleSettingsDelete,
	handleSettingsUpdate,
	handleSiteCreateOrUpdate,
	handleSiteDelete,
}

/**
 * Complete an entry in one Redis script. If its response is lost, Redis has
 * either not run it (the entry is pending) or run both XACK and XDEL; an
 * acknowledged orphan cannot consume the producer capacity limit.
 */
async function acknowledgeCompletedMessage(redisClient: RevalidateRedisClient, id: string): Promise<void> {
	const result = await redisClient.eval(
		COMPLETE_REVALIDATION_SCRIPT,
		1,
		config.revalidateStream,
		config.revalidateGroup,
		id,
	)
	if (!Array.isArray(result) || typeof result[0] !== 'number' || typeof result[1] !== 'number') {
		throw new Error(`Revalidate completion script returned malformed result for ${id}`)
	}
	const [acknowledged, deleted] = result
	if (acknowledged !== 1) {
		logger.warn(`[Revalidate] Completion invariant failed for ${id}: expected XACK 1, got ${acknowledged}`)
		return
	}
	if (deleted !== 1) throw new Error(`Revalidate completion script failed to XDEL ${id}: got ${deleted}`)
}

/** Best-effort cleanup for old acknowledged-orphan entries from pre-atomic releases. */
export async function trimDrainedRevalidationEntries(redisClient: Pick<RevalidateRedisClient, 'eval'>): Promise<void> {
	try {
		const trimmed = await redisClient.eval(
			TRIM_DRAINED_REVALIDATION_SCRIPT,
			1,
			config.revalidateStream,
			config.revalidateGroup,
		)
		if (typeof trimmed !== 'number' || trimmed < 0) {
			logger.warn('[Revalidate] Drained-stream maintenance returned an invalid result')
		}
	} catch (error) {
		// Older Redis versions may not expose group lag. Maintenance is optional;
		// never substitute a risky fallback trim.
		logger.warn(`[Revalidate] Drained-stream maintenance skipped (${errorKind(error)})`)
	}
}

export interface ParsedRevalidationMessage {
	fields: Record<string, string>
	did?: string
	rkey?: string
	reason: string
}

function hasPermanentPdsCode(code: string): boolean {
	return code === 'INVALID_RECORD' || code === 'MISSING_CID'
}

/** Classify without echoing hostile response bodies or URLs. */
export function classifyRevalidationError(error: unknown): RevalidationFailureInfo {
	if (error instanceof RevalidationProcessingError) {
		return { classification: error.classification, code: error.code }
	}
	if (error instanceof SiteBlobBackoffError) return { classification: 'transient', code: 'BLOB_500_BACKOFF' }
	if (error instanceof SubfsExpansionError) {
		const permanent = error.code !== 'FETCH_FAILED'
		return { classification: permanent ? 'permanent' : 'transient', code: error.code }
	}
	if (error instanceof AuthoritativeSiteRecordError) {
		return { classification: hasPermanentPdsCode(error.code) ? 'permanent' : 'transient', code: error.code }
	}
	if (error instanceof AuthoritativeSettingsRecordError) {
		return { classification: hasPermanentPdsCode(error.code) ? 'permanent' : 'transient', code: error.code }
	}
	if (error instanceof SafeFetchHttpError) {
		const retryable = error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
		return { classification: retryable ? 'transient' : 'permanent', code: `HTTP_${error.status}` }
	}
	if (error instanceof SiteLogicalQuotaExceededError) return { classification: 'permanent', code: 'SITE_LOGICAL_QUOTA' }
	if (error instanceof FileLogicalSizeLimitError) return { classification: 'permanent', code: 'FILE_LOGICAL_SIZE' }
	if (error instanceof DecompressionLimitError) return { classification: 'permanent', code: 'DECOMPRESSION_LIMIT' }
	if (error instanceof TransferBudgetExceededError) return { classification: 'transient', code: error.code }
	if (error instanceof RevalidationDeadlineError) return { classification: 'transient', code: error.code }
	const value = error as { code?: unknown; status?: unknown; statusCode?: unknown }
	if (typeof value?.status === 'number' || typeof value?.statusCode === 'number') {
		const status = Number(value.status ?? value.statusCode)
		if (Number.isSafeInteger(status) && status >= 400 && status <= 599) {
			return {
				classification: status === 408 || status === 425 || status === 429 || status >= 500 ? 'transient' : 'permanent',
				code: `HTTP_${status}`,
			}
		}
	}
	if (typeof value?.code === 'string' && /^[A-Z][A-Z0-9_-]{1,63}$/.test(value.code)) {
		const permanent = ['INVALID_RECORD', 'MISSING_CID', 'INVALID_SUBJECT', 'CYCLE', 'DUPLICATE_PATH'].includes(
			value.code,
		)
		return { classification: permanent ? 'permanent' : 'transient', code: value.code }
	}
	const message = error instanceof Error ? error.message : String(error)
	if (/marked gzip|valid gzip|logical size|exceeds .*limit|invalid (?:record|subject)/i.test(message)) {
		return { classification: 'permanent', code: 'INVALID_PAYLOAD' }
	}
	return {
		classification: 'transient',
		code:
			errorKind(error)
				.replace(/[^A-Za-z0-9_-]/g, '_')
				.slice(0, 64) || 'UNKNOWN',
	}
}

function removeControlCharacters(value: string): string {
	return Array.from(value, (character) => {
		const code = character.charCodeAt(0)
		return code <= 0x1f || code === 0x7f ? ' ' : character
	}).join('')
}

function boundedFailureText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	return removeControlCharacters(message).slice(0, 512)
}

function boundedField(value: string | undefined, maximum = 2048): string {
	return removeControlCharacters(value ?? '').slice(0, maximum)
}

export interface RevalidateMessagePolicyOptions {
	/** Redis delivery count; `attempt` is accepted as a compatibility alias. */
	deliveryAttempt?: number
	attempt?: number
	runtimeConfig?: RevalidateWorkerRuntimeConfig
	/** Supply a context in tests or when composing a larger operation. */
	resourceContext?: RevalidationResourceContext
	/** Abort active work when the owning worker lifecycle is stopping. */
	upstreamSignal?: AbortSignal
	/** Internal worker calls set this to enforce bounded processing. */
	enforceAttemptPolicy?: boolean
}

export async function quarantineRevalidationMessage(
	redisClient: RevalidateRedisClient,
	message: ParsedRevalidationMessage,
	id: string,
	error: unknown,
	attempt: number,
	classification: RevalidationFailureClass,
	code?: string,
): Promise<void> {
	const resolvedCode = code ?? classifyRevalidationError(error).code
	const result = await redisClient.eval(
		QUARANTINE_REVALIDATION_SCRIPT,
		2,
		config.revalidateStream,
		config.revalidateDlqStream,
		config.revalidateGroup,
		id,
		boundedField(message.did),
		boundedField(message.rkey),
		boundedField(message.reason),
		boundedField(resolvedCode, 128),
		boundedFailureText(error),
		String(Math.max(1, attempt)),
		classification,
		Date.now().toString(),
		String(config.revalidateDlqStreamMaxLen),
	)
	if (
		!Array.isArray(result) ||
		typeof result[0] !== 'number' ||
		typeof result[1] !== 'string' ||
		typeof result[2] !== 'number'
	) {
		throw new Error(`Revalidate quarantine script returned malformed result for ${id}`)
	}
	if (result[0] !== 1 || result[2] !== 1) {
		throw new Error(`Revalidate quarantine did not ACK and delete ${id}`)
	}
	logger.warn(`[Revalidate] Quarantined ${id} after ${attempt} attempt(s)`, {
		did: message.did,
		rkey: message.rkey,
		reason: message.reason,
		errorCode: resolvedCode,
		classification,
		dlqId: result[1],
	})
}

type VerifiedSiteRecord = NonNullable<Awaited<ReturnType<typeof fetchSiteRecord>>>

interface PreparedSiteRevalidation {
	did: string
	rkey: string
	reason: string
	isDeleteTombstone: boolean
	failureBackoffKey: string
	record: VerifiedSiteRecord
}

function parseRevalidationMessage(rawFields: string[]): ParsedRevalidationMessage {
	const fields = parseFields(rawFields)
	return {
		fields,
		did: fields.did,
		rkey: fields.rkey,
		reason: fields.reason || 'storage-miss',
	}
}

async function setRetrySuppressionTtl(
	redisClient: Pick<RevalidateRedisClient, 'set'>,
	id: string,
	ttlSeconds: number,
): Promise<void> {
	const suppressionTtlSeconds = Math.max(1, Math.ceil(ttlSeconds))
	if (!Number.isSafeInteger(suppressionTtlSeconds)) {
		throw new Error(`Invalid retry suppression TTL for ${id}`)
	}
	const result = await redisClient.set(getRetrySuppressionKey(id), '1', 'EX', suppressionTtlSeconds)
	if (result !== 'OK') throw new Error(`Failed to persist retry suppression for ${id}`)
}

async function reconcileSettingsRevalidation(
	did: string,
	rkey: string,
	dependencies: RevalidateWorkerDependencies,
	resources: RevalidationResourceContext | undefined,
	strict: boolean,
	isDelete: boolean,
): Promise<boolean> {
	// Settings events are reconciled from the current PDS state. This makes an
	// old failed delete safe if a settings record has since reappeared, and makes
	// an old failed update safe if the record has since been deleted. The lookup
	// is handed to the locked writer rather than performed here: a pre-lock
	// record can become stale while waiting for the advisory lock, and doing both
	// lookups would also charge the same revalidation twice.
	assertRevalidationActive(resources)
	const fetchCurrentSettings: typeof fetchSettingsRecordOutcome =
		dependencies.fetchSettingsRecordOutcome ??
		(async (lookupDid, lookupRkey, pdsEndpoint, lookupResources) => {
			const record = await dependencies.fetchSettingsRecord(lookupDid, lookupRkey, pdsEndpoint, lookupResources)
			return record ? { kind: 'present' as const, ...record } : { kind: 'absent' as const }
		})

	try {
		// Both wrappers reconcile against the current PDS record under the lock.
		// Undefined hints are deliberate: only that post-lock lookup is authoritative.
		if (isDelete) {
			await dependencies.handleSettingsDelete(did, rkey, undefined, resources, {
				resources,
				fetchSettingsRecordOutcome: fetchCurrentSettings,
			})
		} else {
			await dependencies.handleSettingsUpdate(did, rkey, undefined, undefined, {
				resources,
				fetchSettingsRecordOutcome: fetchCurrentSettings,
			})
		}
		assertRevalidationActive(resources)
		return true
	} catch (error) {
		if (!(error instanceof AuthoritativeSettingsRecordError)) throw error
		logger.warn(`[Revalidate] Settings PDS lookup remains retryable for ${did}/${rkey}`, {
			outcome: error.code,
		})
		if (strict)
			throw new RevalidationProcessingError(error.code, hasPermanentPdsCode(error.code) ? 'permanent' : 'transient')
		return false
	}
}

async function handleMissingSiteRecord(
	id: string,
	did: string,
	rkey: string,
	isDeleteTombstone: boolean,
	redisClient: RevalidateRedisClient,
	dependencies: RevalidateWorkerDependencies,
	resources?: RevalidationResourceContext,
): Promise<void> {
	if (!isDeleteTombstone) {
		logger.warn(`[Revalidate] Site record not found on PDS: ${did}/${rkey}`)
		assertRevalidationActive(resources)
		await acknowledgeCompletedMessage(redisClient, id)
		return
	}

	// A failed delete must remain pending until its cache/DB cleanup actually
	// succeeds. `handleSiteDelete` is idempotent, so retrying a partial delete
	// is safe.
	logger.info(`[Revalidate] Applying delete tombstone ${id}: ${did}/${rkey}`)
	await dependencies.handleSiteDelete(did, rkey, undefined, resources)
	assertRevalidationActive(resources)
	logger.info(`[Revalidate] Completed delete tombstone ${id}: ${did}/${rkey}`)
	await acknowledgeCompletedMessage(redisClient, id)
}

async function prepareSiteRevalidation(
	id: string,
	did: string,
	rkey: string,
	reason: string,
	redisClient: RevalidateRedisClient,
	dependencies: RevalidateWorkerDependencies,
	resources: RevalidationResourceContext | undefined,
	strict: boolean,
): Promise<PreparedSiteRevalidation | null> {
	const isDeleteTombstone = isSiteDeleteTombstoneReason(reason)
	const failureBackoffKey = getFailureBackoffKey(did, rkey)
	assertRevalidationActive(resources)
	const activeBackoffTtl = await redisClient.ttl(failureBackoffKey)
	assertRevalidationActive(resources)
	if (activeBackoffTtl > 0 && !isDeleteTombstone) {
		// A storage-miss is a durable repair request. Do not ACK it merely because
		// a previous blob 500 installed a site backoff; XAUTOCLAIM must revisit it.
		if (strict || reason.startsWith('storage-miss')) {
			await setRetrySuppressionTtl(redisClient, id, activeBackoffTtl)
			logger.info(
				`[Revalidate] Keeping ${id} pending: ${did}/${rkey} site backoff active (${activeBackoffTtl}s remaining)`,
			)
			return null
		}
		logger.info(`[Revalidate] Acking ${id}: ${did}/${rkey} site backoff active (${activeBackoffTtl}s remaining)`)
		await acknowledgeCompletedMessage(redisClient, id)
		return null
	}

	const outcome = await (dependencies.fetchSiteRecordOutcome
		? dependencies.fetchSiteRecordOutcome(did, rkey, resources)
		: (() => {
				// Compatibility seam for isolated tests; production always supplies the
				// typed outcome API below.
				return dependencies
					.fetchSiteRecord(did, rkey, resources)
					.then((record) => (record ? { kind: 'present' as const, ...record } : { kind: 'absent' as const }))
			})())
	assertRevalidationActive(resources)
	if (outcome.kind === 'retryable') {
		logger.warn(`[Revalidate] PDS lookup remains retryable for ${did}/${rkey}`, { outcome: outcome.error })
		if (strict)
			throw new RevalidationProcessingError(
				outcome.error,
				hasPermanentPdsCode(outcome.error) ? 'permanent' : 'transient',
			)
		return null
	}
	if (outcome.kind === 'absent') {
		await handleMissingSiteRecord(id, did, rkey, isDeleteTombstone, redisClient, dependencies, resources)
		return null
	}
	const record = { record: outcome.record, cid: outcome.cid }

	if (isDeleteTombstone && activeBackoffTtl > 0) {
		// Still look for an absent record above so a real delete is not hidden by a
		// stale blob backoff. If the record has reappeared, preserve this pending
		// tombstone until the backoff expires rather than ACKing it and losing the
		// required current-record materialization.
		await setRetrySuppressionTtl(redisClient, id, activeBackoffTtl)
		logger.info(
			`[Revalidate] Keeping delete tombstone ${id} pending: ${did}/${rkey} site backoff active (${activeBackoffTtl}s remaining)`,
		)
		return null
	}

	return { did, rkey, reason, isDeleteTombstone, failureBackoffKey, record }
}

async function handleSiteMaterializationFailure(
	id: string,
	state: PreparedSiteRevalidation,
	error: unknown,
	redisClient: RevalidateRedisClient,
	strict: boolean,
	resources?: RevalidationResourceContext,
): Promise<void> {
	if (!(error instanceof SiteBlobBackoffError)) throw error

	const now = Date.now()
	const until = Math.max(error.until, now + 1000)
	const ttlSeconds = Math.max(failureBackoffSeconds, Math.ceil((until - now) / 1000))
	assertRevalidationActive(resources)
	await redisClient.set(state.failureBackoffKey, until.toString(), 'EX', ttlSeconds)
	assertRevalidationActive(resources)

	if (state.isDeleteTombstone || strict || state.reason.startsWith('storage-miss')) {
		// Do not ACK a durable repair whose replacement could not be materialized.
		// Leaving it pending lets the bounded worker retry or quarantine it. The
		// per-message key keeps JUSTID scans from turning this wait into deliveries.
		await setRetrySuppressionTtl(redisClient, id, ttlSeconds)
		logger.warn(`[Revalidate] Blob backoff for ${state.did}/${state.rkey}; keeping ${id} pending`, {
			did: state.did,
			rkey: state.rkey,
			failures: error.failures,
			backoffUntil: new Date(until).toISOString(),
			ttlSeconds,
		})
		return
	}

	logger.warn(`[Revalidate] Blob backoff for ${state.did}/${state.rkey}; acking ${id} and suppressing retries`, {
		did: state.did,
		rkey: state.rkey,
		failures: error.failures,
		backoffUntil: new Date(until).toISOString(),
		ttlSeconds,
	})
	await acknowledgeCompletedMessage(redisClient, id)
}

async function materializeSiteRevalidation(
	id: string,
	state: PreparedSiteRevalidation,
	redisClient: RevalidateRedisClient,
	dependencies: RevalidateWorkerDependencies,
	resources: RevalidationResourceContext | undefined,
	strict: boolean,
): Promise<void> {
	// For storage-miss events, force re-download all files since storage is empty.
	// A failed delete can have removed some blobs before its DB cleanup failed, so
	// a reappeared tombstone also needs a full materialization rather than an
	// incremental diff against a potentially stale ledger.
	const forceDownload = state.isDeleteTombstone || state.reason.startsWith('storage-miss')
	const forceRewriteHtml = state.reason.startsWith('rewrite-miss')
	const skipInvalidation = shouldSkipInvalidationForReason(state.reason)

	try {
		assertRevalidationActive(resources)
		await dependencies.handleSiteCreateOrUpdate(state.did, state.rkey, state.record.record, state.record.cid, {
			skipInvalidation,
			forceDownload,
			forceRewriteHtml,
			resources,
		})
	} catch (error) {
		assertRevalidationActive(resources)
		await handleSiteMaterializationFailure(id, state, error, redisClient, strict, resources)
		return
	}

	assertRevalidationActive(resources)
	logger.info(`[Revalidate] Completed ${id}: ${state.did}/${state.rkey}`)
	await acknowledgeCompletedMessage(redisClient, id)
}

/** Process one stream entry under the optional strict resource/attempt policy. */
export async function processRevalidationMessage(
	id: string,
	rawFields: string[],
	redisClient: RevalidateRedisClient,
	dependencies: RevalidateWorkerDependencies = defaultRevalidateWorkerDependencies,
	options: RevalidateMessagePolicyOptions = {},
): Promise<void> {
	const message = parseRevalidationMessage(rawFields)
	const strict =
		options.enforceAttemptPolicy === true ||
		options.deliveryAttempt !== undefined ||
		options.attempt !== undefined ||
		options.runtimeConfig !== undefined
	const runtime = policyConfig(options.runtimeConfig ?? revalidateWorkerRuntimeConfig)
	const suppliedAttempt = options.deliveryAttempt ?? options.attempt
	const ownedResources = options.resourceContext === undefined
	const resources =
		options.resourceContext ??
		createRevalidationResourceContext(
			runtime.revalidationDeadlineMs,
			runtime.transferBudgetBytes,
			options.upstreamSignal,
		)
	const lifecycleCancelled = () => options.upstreamSignal?.aborted === true

	if (lifecycleCancelled()) {
		if (ownedResources) resources.close()
		return
	}

	let attempt: number
	try {
		const measuredAttempt =
			suppliedAttempt ?? (strict ? await getDeliveryAttempt(redisClient as unknown as Redis, id) : 1)
		if (lifecycleCancelled()) {
			if (strict && suppliedAttempt === undefined) clearLocalDeliveryAttempt(id, measuredAttempt)
			if (ownedResources) resources.close()
			return
		}
		attempt = Math.max(1, Math.floor(measuredAttempt))
	} catch (error) {
		if (ownedResources) resources.close()
		throw error
	}

	try {
		if (lifecycleCancelled()) {
			if (strict && suppliedAttempt === undefined) clearLocalDeliveryAttempt(id, attempt)
			return
		}
		if (strict && locallyQuarantinedMessages.has(id)) return
		if (strict && attempt > runtime.maxAttempts) {
			await quarantineRevalidationMessage(
				redisClient,
				message,
				id,
				new RevalidationProcessingError('MAX_ATTEMPTS', 'permanent'),
				attempt,
				'permanent',
				'MAX_ATTEMPTS',
			)
			locallyQuarantinedMessages.add(id)
			if (locallyQuarantinedMessages.size > MAX_LOCAL_QUARANTINED_MESSAGES) {
				const first = locallyQuarantinedMessages.values().next().value as string | undefined
				if (first) locallyQuarantinedMessages.delete(first)
			}
			return
		}
		if (!message.did || !message.rkey) {
			logger.warn('[Revalidate] Missing did/rkey in message', { id, fields: message.fields })
			if (strict) {
				await quarantineRevalidationMessage(
					redisClient,
					message,
					id,
					new RevalidationProcessingError('MALFORMED_MESSAGE', 'permanent'),
					attempt,
					'permanent',
					'MALFORMED_MESSAGE',
				)
				locallyQuarantinedMessages.add(id)
			} else {
				await acknowledgeCompletedMessage(redisClient, id)
			}
			return
		}

		logger.info(`[Revalidate] Received message ${id}: ${message.did}/${message.rkey} (${message.reason})`)
		if (isSettingsFailureRevalidationReason(message.reason)) {
			if (
				await reconcileSettingsRevalidation(
					message.did,
					message.rkey,
					dependencies,
					resources,
					strict,
					message.reason === SETTINGS_DELETE_FAILURE_REASON,
				)
			) {
				assertRevalidationActive(resources)
				await acknowledgeCompletedMessage(redisClient, id)
			}
			return
		}

		const state = await prepareSiteRevalidation(
			id,
			message.did,
			message.rkey,
			message.reason,
			redisClient,
			dependencies,
			resources,
			strict,
		)
		if (!state) return
		await materializeSiteRevalidation(id, state, redisClient, dependencies, resources, strict)
	} catch (error) {
		// A lifecycle stop is not a delivery attempt. Do not ACK, quarantine, or
		// install a retry key after the worker has been fenced; the PEL entry must
		// remain pending for the next consumer/leader.
		if (options.upstreamSignal?.aborted) {
			if (strict && suppliedAttempt === undefined) clearLocalDeliveryAttempt(id, attempt)
			return
		}
		if (!strict) throw error
		const failure = classifyRevalidationError(error)
		if (failure.classification === 'permanent' || attempt >= runtime.maxAttempts) {
			await quarantineRevalidationMessage(
				redisClient,
				message,
				id,
				error,
				attempt,
				failure.classification,
				failure.code,
			)
			locallyQuarantinedMessages.add(id)
			if (locallyQuarantinedMessages.size > MAX_LOCAL_QUARANTINED_MESSAGES) {
				const first = locallyQuarantinedMessages.values().next().value as string | undefined
				if (first) locallyQuarantinedMessages.delete(first)
			}
			return
		}
		const delayMs = revalidateRetryBackoffMs(attempt, runtime.retryBackoffBaseMs, runtime.retryBackoffMaxMs)
		const retryTtlSeconds = Math.max(1, Math.ceil(delayMs / 1000))
		await setRetrySuppressionTtl(redisClient, id, retryTtlSeconds)
		logger.warn(`[Revalidate] Retaining ${id} pending after transient failure`, {
			did: message.did,
			rkey: message.rkey,
			reason: message.reason,
			errorCode: failure.code,
			attempt,
			nextRetryInMs: delayMs,
		})
	} finally {
		if (ownedResources) resources.close()
	}
}

const localDeliveryAttempts = new Map<string, number>()
const locallyQuarantinedMessages = new Set<string>()
const MAX_LOCAL_DELIVERY_ATTEMPTS = 20_000
const MAX_LOCAL_QUARANTINED_MESSAGES = 20_000
/** Never let one stale-entry sweep run forever on a malformed/cyclic cursor. */
const MAX_CLAIM_SCAN_ROUNDS = 100
const STREAM_ID_PATTERN = /^\d+-\d+$/

type WorkerActiveCheck = () => boolean

function parseDeliveryCount(value: unknown): number | undefined {
	const row = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value
	if (!Array.isArray(row)) return undefined
	const count = Number(row[3])
	return Number.isSafeInteger(count) && count >= 1 ? count : undefined
}

function redisText(value: unknown): string | undefined {
	if (typeof value === 'string') return value
	if (value instanceof Uint8Array) return Buffer.from(value).toString()
	return undefined
}

function parseStreamId(value: unknown): string | undefined {
	const id = redisText(value)
	return id && STREAM_ID_PATTERN.test(id) ? id : undefined
}

function parseStreamIdList(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	const ids: string[] = []
	for (const item of value) {
		// JUSTID returns strings, but accepting an entry-shaped item here keeps the
		// scanner safe when a proxy returns the non-JUSTID shape unexpectedly.
		const id = parseStreamId(Array.isArray(item) ? item[0] : item)
		if (id) ids.push(id)
	}
	return ids
}

interface ParsedAutoClaimResponse {
	nextId: string
	claimedIds: string[]
	deletedIds: Set<string>
}

function parseAutoClaimResponse(value: unknown): ParsedAutoClaimResponse | undefined {
	if (!Array.isArray(value)) return undefined
	const nextId = parseStreamId(value[0])
	if (!nextId) return undefined
	return {
		nextId,
		claimedIds: parseStreamIdList(value[1]),
		// Redis 7 adds a third response item containing IDs removed from the PEL
		// because their stream entries were deleted. Older Redis omits it.
		deletedIds: new Set(parseStreamIdList(value[2])),
	}
}

function parseClaimedMessages(value: unknown, requestedIds: ReadonlySet<string>): Array<[string, string[]]> {
	if (!Array.isArray(value)) return []
	const messages: Array<[string, string[]]> = []
	const seen = new Set<string>()
	for (const item of value) {
		if (!Array.isArray(item) || item.length < 2) continue
		const id = parseStreamId(item[0])
		if (!id || !requestedIds.has(id) || seen.has(id)) continue
		const rawFields = item[1]
		if (!Array.isArray(rawFields)) continue
		const fields: string[] = []
		let valid = true
		for (const field of rawFields) {
			const text = redisText(field)
			if (text === undefined) {
				valid = false
				break
			}
			fields.push(text)
		}
		if (!valid) continue
		seen.add(id)
		messages.push([id, fields])
	}
	return messages
}

async function getDeliveryAttempt(client: Redis, id: string): Promise<number> {
	const previous = localDeliveryAttempts.get(id) ?? 0
	let observed: number | undefined
	const xpending = (client as unknown as RevalidateRedisClient).xpending
	if (typeof xpending === 'function') {
		try {
			observed = parseDeliveryCount(
				await xpending.call(client, config.revalidateStream, config.revalidateGroup, id, id, 1),
			)
		} catch {
			// A minimal test seam or an old Redis proxy may not expose XPENDING.
		}
	}
	const attempt = Math.max(observed ?? 0, previous + 1, 1)
	localDeliveryAttempts.set(id, attempt)
	if (localDeliveryAttempts.size > MAX_LOCAL_DELIVERY_ATTEMPTS) {
		const first = localDeliveryAttempts.keys().next().value as string | undefined
		if (first) localDeliveryAttempts.delete(first)
	}
	return attempt
}

function parseRetrySuppressionTtl(value: unknown, id: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < -2) {
		throw new Error(`Malformed retry suppression TTL for ${id}`)
	}
	return value
}

/**
 * Read the retry keys as one bounded pipeline. The optional direct-command
 * fallback keeps minimal test/proxy seams compatible; production ioredis always
 * exposes `pipeline`, so a stale-entry round performs at most one TTL round trip.
 */
async function readRetrySuppressionTtls(client: Redis, ids: readonly string[]): Promise<number[]> {
	if (ids.length === 0) return []
	if (ids.length > MAX_BATCH_SIZE) throw new Error(`Retry suppression pipeline exceeds ${MAX_BATCH_SIZE} IDs`)

	const redisClient = client as unknown as RevalidateRedisClient
	if (typeof redisClient.pipeline !== 'function') {
		// Keep old/minimal seams working without reintroducing a serial scan. The
		// caller already caps `ids` at MAX_BATCH_SIZE, so this fallback is bounded.
		return await Promise.all(
			ids.map(async (id) => parseRetrySuppressionTtl(await redisClient.ttl(getRetrySuppressionKey(id)), id)),
		)
	}

	const pipeline = redisClient.pipeline()
	if (!pipeline || typeof pipeline.ttl !== 'function' || typeof pipeline.exec !== 'function') {
		throw new Error('Redis retry suppression pipeline is malformed')
	}
	for (const id of ids) pipeline.ttl(getRetrySuppressionKey(id))

	const replies = await pipeline.exec()
	if (!Array.isArray(replies) || replies.length !== ids.length) {
		const replyCount = Array.isArray(replies) ? replies.length : 'invalid'
		throw new Error(`Redis retry suppression pipeline returned ${replyCount} replies for ${ids.length} IDs`)
	}

	const ttls: number[] = []
	for (const [index, reply] of replies.entries()) {
		const id = ids[index]
		if (!id || !Array.isArray(reply) || reply.length !== 2) {
			throw new Error(`Malformed retry suppression pipeline reply for ${id ?? 'unknown'}`)
		}
		const [error, value] = reply
		if (error !== null && error !== undefined) {
			if (error instanceof Error) throw error
			throw new Error(`Retry suppression TTL command failed for ${id}: ${String(error)}`)
		}
		ttls.push(parseRetrySuppressionTtl(value, id))
	}
	return ttls
}

function clearLocalDeliveryAttempt(id: string, attempt: number): void {
	if (localDeliveryAttempts.get(id) === attempt) localDeliveryAttempts.delete(id)
}

async function processMessage(
	id: string,
	rawFields: string[],
	client: Redis,
	runtimeConfig: RevalidateWorkerRuntimeConfig,
	dependencies: RevalidateWorkerDependencies = defaultRevalidateWorkerDependencies,
	upstreamSignal?: AbortSignal,
): Promise<void> {
	// A retry backoff is not a delivery. Check it before reading XPENDING or
	// advancing the local fallback counter so repeated scans cannot consume
	// attempts while the message is intentionally waiting. Lifecycle cancellation
	// is checked around each Redis await so a stop cannot add local attempt debt.
	if (upstreamSignal?.aborted) return
	const retryTtl = parseRetrySuppressionTtl(
		await (client as unknown as RevalidateRedisClient).ttl(getRetrySuppressionKey(id)),
		id,
	)
	if (upstreamSignal?.aborted || retryTtl > 0) return
	const deliveryAttempt = await getDeliveryAttempt(client, id)
	if (upstreamSignal?.aborted) {
		clearLocalDeliveryAttempt(id, deliveryAttempt)
		return
	}
	try {
		await processRevalidationMessage(id, rawFields, client as unknown as RevalidateRedisClient, dependencies, {
			deliveryAttempt,
			runtimeConfig,
			upstreamSignal,
			enforceAttemptPolicy: true,
		})
	} finally {
		if (upstreamSignal?.aborted) clearLocalDeliveryAttempt(id, deliveryAttempt)
	}
}

async function processMessages(
	messages: Array<[string, string[]]>,
	client: Redis,
	runtimeConfig: RevalidateWorkerRuntimeConfig,
	dependencies: RevalidateWorkerDependencies = defaultRevalidateWorkerDependencies,
	isActive: WorkerActiveCheck = () => isActiveWorkerClient(client),
	upstreamSignal?: AbortSignal,
): Promise<void> {
	for (const [id, rawFields] of messages) {
		if (!isActive()) return
		try {
			await processMessage(id, rawFields, client, runtimeConfig, dependencies, upstreamSignal)
		} catch (err) {
			logger.error(`[Revalidate] Failed to process message ${id} (${errorKind(err)})`)
		}
	}
}

async function ensureGroup(client: Redis): Promise<void> {
	if (!isActiveWorkerClient(client)) return
	try {
		await client.xgroup('CREATE', config.revalidateStream, config.revalidateGroup, '0', 'MKSTREAM')
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err))
		if (!error.message.includes('BUSYGROUP')) {
			throw error
		}
	}
}

async function claimStaleMessages(
	client: Redis,
	runtimeConfig: RevalidateWorkerRuntimeConfig,
	dependencies: RevalidateWorkerDependencies = defaultRevalidateWorkerDependencies,
	isActive: WorkerActiveCheck = () => isActiveWorkerClient(client),
	upstreamSignal?: AbortSignal,
): Promise<void> {
	let startId = '0-0'
	const visitedCursors = new Set<string>()
	let rounds = 0

	while (isActive() && rounds < MAX_CLAIM_SCAN_ROUNDS) {
		if (visitedCursors.has(startId)) {
			logger.warn(`[Revalidate] Stale-entry scan stopped on repeated cursor ${startId}`)
			break
		}
		visitedCursors.add(startId)
		rounds++

		// JUSTID claims ownership without incrementing the delivery counter. The
		// subsequent XCLAIM below is the only delivery increment for this attempt.
		const rawResponse = await client.xautoclaim(
			config.revalidateStream,
			config.revalidateGroup,
			consumerName,
			runtimeConfig.claimIdleMs,
			startId,
			'COUNT',
			runtimeConfig.batchSize,
			'JUSTID',
		)

		if (!isActive()) return
		const response = parseAutoClaimResponse(rawResponse)
		if (!response) {
			logger.warn('[Revalidate] Stale-entry scan received a malformed XAUTOCLAIM response')
			break
		}

		// Redis honors COUNT, but cap a malformed/proxy response as a final
		// guard against unbounded TTL and XCLAIM work in one scan round.
		const claimedIds: string[] = []
		const seenIds = new Set<string>()
		const scanBatchSize = Number.isSafeInteger(runtimeConfig.batchSize)
			? Math.max(1, Math.min(MAX_BATCH_SIZE, runtimeConfig.batchSize))
			: DEFAULT_BATCH_SIZE
		for (const id of response.claimedIds.slice(0, scanBatchSize)) {
			if (response.deletedIds.has(id) || seenIds.has(id)) continue
			seenIds.add(id)
			claimedIds.push(id)
		}

		const retryTtls = await readRetrySuppressionTtls(client, claimedIds)
		if (!isActive()) return
		const eligibleIds: string[] = []
		for (const [index, id] of claimedIds.entries()) {
			const retryTtl = retryTtls[index]
			if (retryTtl === undefined) throw new Error(`Missing retry suppression TTL for ${id}`)
			if (retryTtl > 0) continue
			eligibleIds.push(id)
		}

		if (eligibleIds.length > 0) {
			// XCLAIM retrieves fields and increments deliveries exactly once for
			// each eligible ID. Deleted entries are simply absent from this reply.
			const claimedMessages = parseClaimedMessages(
				await client.xclaim(config.revalidateStream, config.revalidateGroup, consumerName, 0, ...eligibleIds),
				new Set(eligibleIds),
			)
			if (!isActive()) return
			await processMessages(claimedMessages, client, runtimeConfig, dependencies, isActive, upstreamSignal)
			if (!isActive()) return
		}

		if (response.nextId === '0-0' || response.nextId === startId) break
		startId = response.nextId
	}

	if (rounds >= MAX_CLAIM_SCAN_ROUNDS && isActive()) {
		logger.warn(`[Revalidate] Stale-entry scan reached ${MAX_CLAIM_SCAN_ROUNDS} rounds`)
	}
}

/** @internal Command seam for tests; production uses the worker's active check. */
export async function scanStaleRevalidationMessagesForTests(
	client: Redis,
	runtimeConfig: RevalidateWorkerRuntimeConfig,
	dependencies: RevalidateWorkerDependencies = defaultRevalidateWorkerDependencies,
): Promise<void> {
	await claimStaleMessages(client, runtimeConfig, dependencies, () => true)
}

async function readNewMessages(
	client: Redis,
	runtimeConfig: RevalidateWorkerRuntimeConfig,
	dependencies: RevalidateWorkerDependencies = defaultRevalidateWorkerDependencies,
	upstreamSignal?: AbortSignal,
): Promise<boolean> {
	// BLOCK bounds normal idle reads. ioredis's blockingTimeout resolves a
	// half-open command after BLOCK + grace, while socketTimeout tears down a
	// dead connection instead of letting the worker or shutdown wait forever.
	const response = (await client.xreadgroup(
		'GROUP',
		config.revalidateGroup,
		consumerName,
		'COUNT',
		runtimeConfig.batchSize,
		'BLOCK',
		runtimeConfig.blockMs,
		'STREAMS',
		config.revalidateStream,
		'>',
	)) as [string, Array<[string, string[]]>][] | null

	if (!response || !isActiveWorkerClient(client)) return false

	let received = false
	for (const [, messages] of response) {
		if (messages.length > 0) received = true
		await processMessages(messages, client, runtimeConfig, dependencies, undefined, upstreamSignal)
		if (!isActiveWorkerClient(client)) return false
	}
	return received
}

export function fullJitterDelay(attempt: number, minimumMs: number, maximumMs: number, random = Math.random): number {
	const cap = Math.min(maximumMs, minimumMs * 2 ** Math.min(attempt, 30))
	return Math.floor(random() * (cap + 1))
}

function waitForReconnect(delayMs: number): Promise<void> {
	if (!running) return Promise.resolve()
	return new Promise((resolve) => {
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			if (cancelLoopRetryWait === finish) cancelLoopRetryWait = null
			resolve()
		}
		const timer = setTimeout(finish, delayMs)
		cancelLoopRetryWait = () => {
			clearTimeout(timer)
			finish()
		}
	})
}

async function runLoop(
	client: Redis,
	runtimeConfig: RevalidateWorkerRuntimeConfig,
	onHealthyIteration: () => void = () => undefined,
	upstreamSignal?: AbortSignal,
	dependencies: RevalidateWorkerDependencies = defaultRevalidateWorkerDependencies,
): Promise<void> {
	await ensureGroup(client)

	while (isActiveWorkerClient(client)) {
		try {
			await claimStaleMessages(client, runtimeConfig, dependencies, undefined, upstreamSignal)
			const received = await readNewMessages(client, runtimeConfig, dependencies, upstreamSignal)
			if (!isActiveWorkerClient(client)) return
			// A successful XREADGROUP (including a healthy timeout) proves this
			// connection recovered. Reset reconnect backoff while the loop is live,
			// rather than waiting for runLoop to return during shutdown.
			onHealthyIteration()
			if (!received) await trimDrainedRevalidationEntries(client)
		} catch (err) {
			if (!isActiveWorkerClient(client)) break
			throw err
		}
	}
}

export interface RevalidateWorkerTestHooks {
	/** Deterministic backoff source for supervisor tests. */
	random?: () => number
	/** Replace the cancellable production wait in supervisor tests. */
	waitForReconnect?: (delayMs: number) => Promise<void>
	/** Isolated dependencies for lifecycle/cancellation tests. */
	dependencies?: RevalidateWorkerDependencies
}

function startRevalidateWorkerWithFactory(
	redisUrl: string | undefined,
	redisClientFactory: RevalidateWorkerRedisFactory,
	runtimeConfig: RevalidateWorkerRuntimeConfig,
	hooks: RevalidateWorkerTestHooks = {},
): void {
	if (!redisUrl) {
		logger.warn('[Revalidate] REDIS_URL not set; revalidate worker disabled')
		return
	}
	// A timed-out previous loop may still be executing an uncooperative handler.
	// Never start a replacement that could overlap its shared dependencies.
	if (running || loopPromise) return
	running = true
	const generation = ++workerGeneration
	const abortController = new AbortController()
	workerAbortController = abortController
	let attempt = 0
	const supervise = async () => {
		while (running) {
			let client: Redis | null = null
			try {
				client = redisClientFactory(redisUrl, createRevalidateWorkerRedisOptions(runtimeConfig))
				redis = client
				client.on('error', (err) => logger.error(`[Revalidate] Redis error (${errorKind(err)})`))
				client.on('ready', () =>
					logger.info(
						`[Revalidate] Redis connected, stream: ${config.revalidateStream}, group: ${config.revalidateGroup}`,
					),
				)
				await runLoop(
					client,
					runtimeConfig,
					() => {
						attempt = 0
					},
					abortController.signal,
					hooks.dependencies,
				)
				attempt = 0
			} catch (err) {
				if (running) logger.error(`[Revalidate] Redis worker connection failed (${errorKind(err)})`)
			} finally {
				if (redis === client) redis = null
				client?.disconnect()
			}
			if (!running) break
			const delay = fullJitterDelay(attempt++, runtimeConfig.reconnectMinMs, runtimeConfig.reconnectMaxMs, hooks.random)
			await (hooks.waitForReconnect ?? waitForReconnect)(delay)
		}
	}
	const trackedLoop = supervise().finally(() => {
		if (loopPromise === trackedLoop) loopPromise = null
		if (workerGeneration === generation && !redis) {
			running = false
			workerAbortController = null
		}
	})
	loopPromise = trackedLoop
}

export async function startRevalidateWorker(): Promise<void> {
	startRevalidateWorkerWithFactory(config.redisUrl, defaultRedisClientFactory, revalidateWorkerRuntimeConfig)
}

export function startRevalidateWorkerForTests(
	redisClientFactory: RevalidateWorkerRedisFactory,
	redisUrl = 'redis://revalidate-worker-test',
	runtimeConfig: RevalidateWorkerRuntimeConfig = revalidateWorkerRuntimeConfig,
	hooks: RevalidateWorkerTestHooks = {},
): void {
	startRevalidateWorkerWithFactory(redisUrl, redisClientFactory, runtimeConfig, hooks)
}

export interface RevalidateWorkerState {
	running: boolean
	hasRedisClient: boolean
	hasLoop: boolean
}

export function getRevalidateWorkerState(): RevalidateWorkerState {
	return {
		running,
		hasRedisClient: redis !== null,
		hasLoop: loopPromise !== null,
	}
}

/** @internal Backward-compatible test seam. */
export const getRevalidateWorkerStateForTests = getRevalidateWorkerState

export interface RevalidateWorkerStopOptions {
	/** Maximum time to await an in-flight handler before reporting unsafe stop. */
	gracePeriodMs?: number
}

export interface RevalidateWorkerStopResult {
	/** True only when the worker loop settled before the grace period elapsed. */
	stopped: boolean
	/** A timeout means the process must not release shared authority. */
	forced: boolean
}

async function settlesWithinWorkerGrace(work: Promise<void> | null, gracePeriodMs: number): Promise<boolean> {
	if (!work) return true
	if (gracePeriodMs <= 0) return false
	return await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), gracePeriodMs)
		void work.then(
			() => {
				clearTimeout(timer)
				resolve(true)
			},
			() => {
				clearTimeout(timer)
				resolve(false)
			},
		)
	})
}

export async function stopRevalidateWorker(
	options: RevalidateWorkerStopOptions = {},
): Promise<RevalidateWorkerStopResult> {
	running = false
	cancelLoopRetryWait?.()

	// Abort active PDS/blob work before disconnecting Redis. The resource context
	// treats this as lifecycle cancellation, not a delivery failure, so the PEL
	// entry remains pending without ACK/XDEL, quarantine, or retry-key writes.
	const generation = workerGeneration
	const abortController = workerAbortController
	abortController?.abort(new Error('Revalidation worker stopping'))

	// Disconnect before awaiting the loop so a BLOCKing XREADGROUP rejects
	// immediately. disconnect() also prevents another reconnect during shutdown.
	const clientToClose = redis
	redis = null
	const loopToWait = loopPromise
	clientToClose?.disconnect()

	const gracePeriodMs = options.gracePeriodMs ?? config.firehoseDrainGraceMs
	const stopped = await settlesWithinWorkerGrace(loopToWait, gracePeriodMs)
	if (!stopped) return { stopped: false, forced: true }
	if (workerGeneration === generation && workerAbortController === abortController) {
		workerAbortController = null
	}
	return { stopped: true, forced: false }
}
