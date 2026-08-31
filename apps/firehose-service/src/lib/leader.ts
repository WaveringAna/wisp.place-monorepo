/**
 * Leader election for distributed firehose deployments.
 *
 * Only one instance connects to the firehose at a time. Cursor keys are scoped
 * to a non-secret relay fingerprint because relay sequence spaces are local.
 */

import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createLogger } from '@wispplace/observability'
import Redis from 'ioredis'
import { config } from '../config'

const logger = createLogger('firehose-service')

const LEADER_KEY = 'wisp:firehose-leader'
const CURSOR_KEY_PREFIX = 'wisp:firehose-cursor'
const CURSOR_PATTERN = /^(0|[1-9][0-9]*)$/

// Unique ID for this process instance
const instanceId = randomUUID()

// Lua script: renew leadership only if this instance still owns the key
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('set', KEYS[1], ARGV[1], 'XX', 'PX', tonumber(ARGV[2]))
else
  return 0
end
`

// Lua script: release leadership only if this instance still owns the key
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`

const LUA_CURSOR_DECIMAL_HELPERS = `
local maxSafe = '9007199254740991'
local function valid(value)
  if not value or value == '' then return false end
  if value == '0' then return true end
  if not string.match(value, '^[1-9][0-9]*$') then return false end
  if string.len(value) < string.len(maxSafe) then return true end
  return string.len(value) == string.len(maxSafe) and value <= maxSafe
end
local function atLeast(left, right)
  if string.len(left) ~= string.len(right) then return string.len(left) > string.len(right) end
  return left >= right
end
`

/** Atomically keep the greatest cursor in one relay's sequence space. */
export const SAVE_CURSOR_SCRIPT = `
${LUA_CURSOR_DECIMAL_HELPERS}
local current = redis.call('get', KEYS[1])
local next = ARGV[1]
if valid(current) and atLeast(current, next) then
  return 0
end
redis.call('set', KEYS[1], next)
return 1
`

/**
 * Atomically copy the same-relay legacy cursor into the hashed key without
 * ever moving the hashed key backwards. The client verifies the returned
 * cursor with a second read before it removes the legacy key.
 */
export const MIGRATE_CURSOR_SCRIPT = `
${LUA_CURSOR_DECIMAL_HELPERS}
local current = redis.call('get', KEYS[1])
local legacy = redis.call('get', KEYS[2])
if not valid(legacy) then
  return {0, current or ''}
end

local selected = legacy
if valid(current) and atLeast(current, legacy) then selected = current end
if not valid(current) or current ~= selected then redis.call('set', KEYS[1], selected) end
return {1, selected}
`

/**
 * Remove a legacy cursor only when both keys are valid and the hashed cursor
 * is at least as new as the legacy cursor at the instant of deletion.
 *
 * Return values: 1 deleted, 0 already absent, -1 malformed legacy, -2
 * malformed hashed value, -3 legacy became newer and needs another migration,
 * -4 hashed value fell below the cursor that was re-read by the client.
 */
export const DELETE_MIGRATED_CURSOR_SCRIPT = `
${LUA_CURSOR_DECIMAL_HELPERS}
local current = redis.call('get', KEYS[1])
local legacy = redis.call('get', KEYS[2])
local expected = ARGV[1]
if not valid(current) then return -2 end
if not valid(expected) then return -4 end
if legacy and valid(legacy) and not atLeast(current, legacy) then return -3 end
if not atLeast(current, expected) then return -4 end
if not legacy then return 0 end
if not valid(legacy) then return -1 end
return redis.call('del', KEYS[2])
`

function errorKind(error: unknown): string {
	return error instanceof Error && error.name ? error.name : 'UnknownError'
}

class AmbiguousLegacyCursorError extends Error {
	constructor(hashedKey: string) {
		super(
			`Ambiguous legacy cursor for a non-root relay path; preseed ${hashedKey} with the correct checkpoint before startup`,
		)
		this.name = 'AmbiguousLegacyCursorError'
	}
}

/** A stable non-secret relay identifier for Redis keys and diagnostic labels. */
export function relayFingerprint(service: string): string {
	let normalized = 'invalid-relay'
	try {
		const url = new URL(service)
		normalized = `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || 'default'}${url.pathname}`
	} catch {
		// Configuration validates relays before this module starts. Keep a stable
		// fallback to avoid ever placing a raw malformed value in a key or log.
	}
	return createHash('sha256').update(normalized).digest('hex')
}

function relayLabel(service: string): string {
	if (service === config.firehoseService) return 'primary'
	if (service === config.firehoseServiceSecondary) return 'secondary'
	return `relay-${relayFingerprint(service)}`
}

function cursorKey(service: string): string {
	return `${CURSOR_KEY_PREFIX}:${relayFingerprint(service)}`
}

/**
 * Previous releases keyed cursors by host. Keep deriving that key so operators
 * can identify old data, but only root relay URLs may import it: URL paths on
 * the same host cannot be disambiguated.
 */
export function legacyCursorKey(service: string): string | undefined {
	try {
		return `${CURSOR_KEY_PREFIX}:${new URL(service).host}`
	} catch {
		return undefined
	}
}

function isRootRelayPath(service: string): boolean {
	try {
		return new URL(service).pathname === '/'
	} catch {
		return false
	}
}

export function isValidCursor(seq: unknown): seq is number {
	return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0
}

/** Parses only decimal nonnegative safe integers. */
export function parseStoredCursor(value: string | null): number | undefined {
	if (!value || !CURSOR_PATTERN.test(value)) return undefined
	const parsed = Number(value)
	return isValidCursor(parsed) ? parsed : undefined
}

/** Missing and corrupt values both mean there is no confirmed checkpoint. */
export function boundedCursorFromStoredValue(value: string | null): number | undefined {
	return parseStoredCursor(value)
}

/** Pure mirror of the atomic Redis cursor rule, used for validation/tests. */
export function shouldAdvanceStoredCursor(value: string | null, next: number): boolean {
	if (!isValidCursor(next)) return false
	const current = parseStoredCursor(value)
	return current === undefined || current < next
}

const MIN_REDIS_OPERATION_TIMEOUT_MS = 100
const MAX_REDIS_OPERATION_TIMEOUT_MS = 5_000

/** Keep every Redis operation short enough to leave a substantial lease margin. */
function redisOperationTimeoutMs(): number {
	const ttl = config.leaderTtlMs
	if (!Number.isSafeInteger(ttl) || ttl < 1) return MIN_REDIS_OPERATION_TIMEOUT_MS
	return Math.max(MIN_REDIS_OPERATION_TIMEOUT_MS, Math.min(MAX_REDIS_OPERATION_TIMEOUT_MS, Math.floor(ttl / 8)))
}

class RedisOperationTimeoutError extends Error {
	constructor(operation: string) {
		super(`${operation} timed out`)
		this.name = 'RedisOperationTimeoutError'
	}
}

function withRedisTimeout<T>(operation: PromiseLike<T>, timeoutMs: number, operationName: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new RedisOperationTimeoutError(operationName)), timeoutMs)
		Promise.resolve(operation).then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

let redis: Redis | null = null
let redisConnectPromise: Promise<void> | null = null

function getRedis(): Redis {
	if (!redis) {
		if (!config.redisUrl) throw new Error('REDIS_URL is required for leader election')
		const timeoutMs = redisOperationTimeoutMs()
		redis = new Redis(config.redisUrl, {
			// A lease operation must not sit behind ioredis's retry queue. The
			// explicit command timeout below is deliberately much shorter than TTL.
			maxRetriesPerRequest: 0,
			connectTimeout: timeoutMs,
			commandTimeout: timeoutMs,
			enableOfflineQueue: false,
			enableReadyCheck: true,
			lazyConnect: true,
		})
		redis.on('error', (error) => logger.error('[Leader] Redis error', undefined, { errorKind: errorKind(error) }))
	}
	return redis
}

function waitForRedisReady(client: Redis): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (error?: unknown) => {
			if (settled) return
			settled = true
			client.removeListener('ready', onReady)
			client.removeListener('error', onError)
			if (error === undefined) resolve()
			else reject(error)
		}
		const onReady = () => finish()
		const onError = (error: unknown) => finish(error)
		client.once('ready', onReady)
		client.once('error', onError)
	})
}

async function ensureRedisConnected(client: Redis): Promise<void> {
	// Keep the command boundary usable with lightweight test doubles while the
	// real ioredis client always exposes status/connect and is fully bounded.
	if (typeof client.connect !== 'function' || typeof client.status !== 'string') return
	if (client.status === 'ready') return
	if (redisConnectPromise) return redisConnectPromise

	const attempt = (async () => {
		const timeoutMs = redisOperationTimeoutMs()
		if (client.status === 'wait') {
			await withRedisTimeout(client.connect(), timeoutMs, 'Redis connect')
			return
		}
		await withRedisTimeout(waitForRedisReady(client), timeoutMs, 'Redis connect')
	})()
	const tracked = attempt.finally(() => {
		if (redisConnectPromise === tracked) redisConnectPromise = null
	})
	redisConnectPromise = tracked
	return tracked
}

function resetRedisClient(client: Redis): void {
	if (redis !== client) return
	redis = null
	redisConnectPromise = null
	try {
		client.disconnect()
	} catch {
		// The next bounded operation creates a fresh client.
	}
}

async function runRedisCommand<T>(operationName: string, command: (client: Redis) => PromiseLike<T>): Promise<T> {
	const client = getRedis()
	try {
		await ensureRedisConnected(client)
		return await withRedisTimeout(
			Promise.resolve().then(() => command(client)),
			redisOperationTimeoutMs(),
			operationName,
		)
	} catch (error) {
		// A timeout can leave an ioredis command queued behind a dead socket.
		// Fence that client so a later election attempt cannot reuse it.
		if (error instanceof RedisOperationTimeoutError || client.status === 'end' || client.status === 'close') {
			resetRedisClient(client)
		}
		throw error
	}
}

async function tryBecomeLeader(): Promise<boolean> {
	const result = await runRedisCommand('Redis leader acquisition', (client) =>
		client.set(LEADER_KEY, instanceId, 'PX', config.leaderTtlMs, 'NX'),
	)
	return result === 'OK'
}

async function renewLeadership(): Promise<boolean> {
	const result = (await runRedisCommand('Redis leader renewal', (client) =>
		client.eval(RENEW_SCRIPT, 1, LEADER_KEY, instanceId, String(config.leaderTtlMs)),
	)) as string | null
	return result === 'OK'
}

export async function releaseLeadership(): Promise<void> {
	try {
		const deleted = (await runRedisCommand('Redis leader release', (client) =>
			client.eval(RELEASE_SCRIPT, 1, LEADER_KEY, instanceId),
		)) as number
		if (deleted === 1) logger.info('[Leader] Released leader key for standby takeover')
	} catch (error) {
		logger.warn('[Leader] Failed to release leader key', { errorKind: errorKind(error) })
	}
}

export type DurableCursorRead = { kind: 'found'; cursor: number } | { kind: 'missing' } | { kind: 'unavailable' }

export type DurableCursorSave = { kind: 'saved' } | { kind: 'invalid' } | { kind: 'unavailable' }

/**
 * Save a relay-scoped cursor and report whether Redis durably accepted it.
 * The boolean is intentionally separate from the legacy void API so relay
 * failover can refuse to subscribe from an unknown checkpoint.
 */
export async function saveDurableCursor(seq: number, service: string): Promise<DurableCursorSave> {
	if (!isValidCursor(seq)) {
		logger.warn('[Leader] Refused to save an invalid cursor')
		return { kind: 'invalid' }
	}
	try {
		const result = await runRedisCommand('Redis cursor save', (client) =>
			client.eval(SAVE_CURSOR_SCRIPT, 1, cursorKey(service), String(seq)),
		)
		if (result !== 0 && result !== 1 && result !== '0' && result !== '1') {
			throw new Error('Redis cursor save returned an invalid result')
		}
		return { kind: 'saved' }
	} catch (error) {
		logger.warn('[Leader] Failed to save cursor', { errorKind: errorKind(error), relay: relayLabel(service) })
		return { kind: 'unavailable' }
	}
}

/** Backward-compatible best-effort cursor save used by periodic checkpointing. */
export async function saveCursor(seq: number, service: string): Promise<void> {
	await saveDurableCursor(seq, service)
}

export interface CursorRedisClient {
	get(key: string): Promise<string | null>
	eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>
}

export type CursorReadDetails = {
	read: DurableCursorRead
	migrated: boolean
	corrupt: boolean
}

const MAX_CURSOR_MIGRATION_ATTEMPTS = 3

function redisIntegerResult(value: unknown): number | undefined {
	if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined
	if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) return undefined
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) ? parsed : undefined
}

function parseCursorMigrationResult(value: unknown): { status: 0 | 1; cursorValue: string } {
	if (!Array.isArray(value) || value.length < 2) throw new Error('Redis cursor migration returned an invalid result')
	const status = redisIntegerResult(value[0])
	if (status !== 0 && status !== 1) throw new Error('Redis cursor migration returned an invalid status')
	const cursorValue = value[1]
	if (typeof cursorValue !== 'string') throw new Error('Redis cursor migration returned an invalid cursor')
	return { status, cursorValue }
}

function parseCursorDeletionResult(value: unknown): number {
	const result = redisIntegerResult(value)
	if (result !== 0 && result !== 1 && result !== -1 && result !== -2 && result !== -3 && result !== -4) {
		throw new Error('Redis legacy cursor deletion returned an invalid result')
	}
	return result
}

async function readCursorWithoutLegacy(client: CursorRedisClient, key: string): Promise<CursorReadDetails> {
	const value = await client.get(key)
	const cursor = parseStoredCursor(value)
	if (cursor !== undefined) return { read: { kind: 'found', cursor }, migrated: false, corrupt: false }
	return { read: { kind: 'missing' }, migrated: false, corrupt: value !== null }
}

/**
 * Read a cursor and migrate the previous same-relay host key for root relay URLs.
 * Non-root URLs cannot safely identify which independent path produced a host-only
 * legacy key, so an existing legacy value requires an operator preseed instead.
 *
 * The migration script atomically takes the maximum of both valid values. We
 * then re-read the hashed key and only run the conditional delete script after
 * that re-read proves a valid cursor at least as new as the migrated value.
 * This keeps a failed read, a malformed concurrent write, or a racing newer
 * legacy value from deleting the only recoverable checkpoint.
 */
export async function readDurableCursorWithRedis(
	client: CursorRedisClient,
	service: string,
): Promise<CursorReadDetails> {
	const key = cursorKey(service)
	const oldKey = legacyCursorKey(service)
	if (!isRootRelayPath(service)) {
		const hashedValue = await client.get(key)
		const hashedCursor = parseStoredCursor(hashedValue)
		if (hashedCursor !== undefined)
			return { read: { kind: 'found', cursor: hashedCursor }, migrated: false, corrupt: false }

		// A host-only legacy key may belong to any independent URL path on this
		// host. Never import it into a path-scoped key. An operator must preseed
		// the hashed key from the correct relay checkpoint before startup.
		if (oldKey && oldKey !== key && (await client.get(oldKey)) !== null) {
			throw new AmbiguousLegacyCursorError(key)
		}
		return { read: { kind: 'missing' }, migrated: false, corrupt: hashedValue !== null }
	}
	if (!oldKey || oldKey === key) return readCursorWithoutLegacy(client, key)

	for (let attempt = 0; attempt < MAX_CURSOR_MIGRATION_ATTEMPTS; attempt++) {
		const migration = parseCursorMigrationResult(await client.eval(MIGRATE_CURSOR_SCRIPT, 2, key, oldKey))
		const migratedCursor = parseStoredCursor(migration.cursorValue)
		if (migration.status === 0) {
			if (migratedCursor !== undefined)
				return { read: { kind: 'found', cursor: migratedCursor }, migrated: false, corrupt: false }
			return { read: { kind: 'missing' }, migrated: false, corrupt: migration.cursorValue !== '' }
		}
		if (migratedCursor === undefined) throw new Error('Redis legacy cursor migration produced an invalid cursor')

		const rereadCursor = parseStoredCursor(await client.get(key))
		if (rereadCursor === undefined || rereadCursor < migratedCursor) {
			throw new Error('Redis cursor changed before legacy migration was confirmed')
		}

		const deletion = parseCursorDeletionResult(
			await client.eval(DELETE_MIGRATED_CURSOR_SCRIPT, 2, key, oldKey, String(rereadCursor)),
		)
		if (deletion === 1 || deletion === 0) {
			return { read: { kind: 'found', cursor: rereadCursor }, migrated: true, corrupt: false }
		}
		if (deletion === -1) {
			// The legacy value changed to malformed data after migration. Keep it so
			// no unverified delete can destroy a potentially recoverable checkpoint.
			return { read: { kind: 'found', cursor: rereadCursor }, migrated: false, corrupt: false }
		}
		if (deletion === -2 || deletion === -4)
			throw new Error('Redis cursor changed before legacy migration was confirmed')
		// A newer legacy value won the race. Re-run the atomic max and confirmation
		// sequence rather than deleting that newer checkpoint.
	}
	throw new Error('Redis legacy cursor migration changed concurrently')
}

/**
 * Distinguish a missing checkpoint from an unavailable durable store. A missing
 * or corrupt value is a confirmed absence and starts the relay live; an
 * unavailable store must not cause a relay subscription from an unknown position.
 */
export async function readDurableCursor(service: string): Promise<DurableCursorRead> {
	try {
		const result = await runRedisCommand('Redis cursor read', (client) => readDurableCursorWithRedis(client, service))
		if (result.migrated) logger.info('[Leader] Migrated same-relay legacy cursor checkpoint')
		if (result.corrupt && result.read.kind === 'missing') {
			logger.warn('[Leader] Ignoring corrupt saved cursor; starting live', { relay: relayLabel(service) })
		}
		return result.read
	} catch (error) {
		if (error instanceof AmbiguousLegacyCursorError) {
			logger.error('[Leader] Ambiguous legacy cursor; preseed the path-scoped cursor before startup', undefined, {
				relay: relayLabel(service),
			})
		} else {
			logger.warn('[Leader] Failed to read cursor', { errorKind: errorKind(error), relay: relayLabel(service) })
		}
		return { kind: 'unavailable' }
	}
}

/** Backward-compatible cursor reader for leader startup. */
export async function readCursor(service: string): Promise<number | undefined> {
	const result = await readDurableCursor(service)
	if (result.kind === 'unavailable') throw new Error('Durable cursor store is unavailable')
	// A confirmed missing or corrupt checkpoint starts from the relay head. Only
	// an unavailable store is an error and must fail closed before subscription.
	return result.kind === 'found' ? result.cursor : undefined
}

export function getLeaderInfo() {
	return { instanceId }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms)
		const onAbort = () => {
			clearTimeout(timer)
			done()
		}
		function done() {
			signal.removeEventListener('abort', onAbort)
			resolve()
		}
		signal.addEventListener('abort', onAbort, { once: true })
	})
}

/** Returns true only when direct firehose work drained safely. */
type LeadershipLossCallback = () => boolean | Promise<boolean>
type LeadershipStartCallback = (
	cursor: number | undefined,
	stepDown: () => Promise<void>,
	isActive: () => boolean,
) => void | Promise<void>

export interface LeaderElectionDependencies {
	tryBecomeLeader(): Promise<boolean>
	renewLeadership(): Promise<boolean>
	releaseLeadership(): Promise<void>
	readCursor(service: string): Promise<number | undefined>
	sleep(ms: number, signal: AbortSignal): Promise<void>
	/** Monotonic clock seam for deterministic lease-deadline tests. */
	now?: () => number
	/** Timer seams keep lease-loss ordering tests deterministic. */
	setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
	clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
}

const defaultLeaderElectionDependencies: LeaderElectionDependencies = {
	tryBecomeLeader,
	renewLeadership,
	releaseLeadership,
	readCursor,
	sleep,
}

const MIN_LEASE_SAFETY_MARGIN_MS = 100

function leaseSafetyMarginMs(): number {
	// Keep a quarter of the configured TTL as a local safety window. Redis
	// operations are bounded to a smaller fraction, and the lease deadline is
	// enforced independently of renewal response timing.
	return Math.max(MIN_LEASE_SAFETY_MARGIN_MS, Math.floor(config.leaderTtlMs / 4))
}

function leaseValidityWindowMs(): number {
	return Math.max(1, config.leaderTtlMs - leaseSafetyMarginMs())
}

/**
 * Owns one process's Redis lease state. Epochs fence late renewal responses so
 * an old timer cannot modify a later leadership term after a release/reacquire.
 * The monotonic deadline is deliberately separate from renewal failures: a
 * hung renewal cannot keep this process acting as leader past its local safety
 * window.
 */
class LeaderElectionMachine {
	private isLeader = false
	private renewalTimer: ReturnType<typeof setTimeout> | null = null
	private leaseDeadlineTimer: ReturnType<typeof setTimeout> | null = null
	private leaseDeadline: number | null = null
	private renewalInFlightEpoch: number | null = null
	private steppingDown: Promise<void> | null = null
	private leadershipLoss: Promise<boolean> | null = null
	private abortLoss: Promise<void> = Promise.resolve()
	private lostLeadershipDrain: Promise<boolean> | null = null
	private terminalError: Error | null = null
	private leadershipEpoch = 0
	private readonly terminalWake: Promise<void>
	private resolveTerminalWake: (() => void) | null = null

	constructor(
		private readonly onBecomeLeader: LeadershipStartCallback,
		private readonly onLoseLeadership: LeadershipLossCallback,
		private readonly signal: AbortSignal,
		private readonly initialService: string,
		private readonly dependencies: LeaderElectionDependencies = defaultLeaderElectionDependencies,
	) {
		this.terminalWake = new Promise((resolve) => {
			this.resolveTerminalWake = resolve
		})
	}

	async run(): Promise<void> {
		logger.info('[Leader] Starting election loop', { relay: relayLabel(this.initialService) })
		this.signal.addEventListener('abort', this.onAbort, { once: true })
		try {
			while (this.canContinue()) await this.runCycle()
		} finally {
			this.signal.removeEventListener('abort', this.onAbort)
			await this.abortLoss
		}
		if (this.terminalError) throw this.terminalError
	}

	private canContinue(): boolean {
		return !this.signal.aborted && this.terminalError === null
	}

	private async runCycle(): Promise<void> {
		if (this.isLeader) {
			this.checkLeaseDeadline()
			if (!this.isLeader) return
			await Promise.race([this.dependencies.sleep(config.leaderPollIntervalMs, this.signal), this.terminalWake])
			// A fake or delayed clock may advance without allowing a native timer to
			// run. Check again after every election-loop sleep as a second fence.
			this.checkLeaseDeadline()
			return
		}
		await this.tryAcquireLeadership()
	}

	private async tryAcquireLeadership(): Promise<void> {
		if (!(await this.awaitLostLeadershipDrain()) || !this.canContinue()) return

		const won = await this.tryBecomeLeader()
		if (!won) {
			await Promise.race([this.dependencies.sleep(config.leaderPollIntervalMs, this.signal), this.terminalWake])
			return
		}
		if (!this.canContinue()) {
			await this.dependencies.releaseLeadership()
			return
		}
		const started = await this.startLeaderWork()
		if (!started && this.canContinue()) {
			await Promise.race([this.dependencies.sleep(config.leaderPollIntervalMs, this.signal), this.terminalWake])
		}
	}

	private async awaitLostLeadershipDrain(): Promise<boolean> {
		const pendingDrain = this.lostLeadershipDrain
		if (!pendingDrain) return true

		const drained = await pendingDrain
		if (this.lostLeadershipDrain === pendingDrain) this.lostLeadershipDrain = null
		if (this.leadershipLoss === pendingDrain) this.leadershipLoss = null
		if (drained) return true
		this.markTerminal('Leader election stopped after an unsafe leadership drain')
		return false
	}

	private async tryBecomeLeader(): Promise<boolean> {
		try {
			return await this.dependencies.tryBecomeLeader()
		} catch (error) {
			logger.error('[Leader] Election attempt failed', undefined, { errorKind: errorKind(error) })
			return false
		}
	}

	private async startLeaderWork(): Promise<boolean> {
		const epoch = ++this.leadershipEpoch
		this.isLeader = true
		this.leaseDeadline = this.monotonicNow() + leaseValidityWindowMs()
		this.armLeaseDeadline(epoch)
		this.scheduleRenewal(epoch)

		try {
			const cursor = await this.dependencies.readCursor(this.initialService)
			// The lease deadline can fire while a durable cursor read is in flight.
			// Never start work from a term which was fenced during that await.
			if (!this.isActiveEpoch(epoch)) return false
			logger.info('[Leader] Won leadership', {
				relay: relayLabel(this.initialService),
				hasCursor: cursor !== undefined,
			})
			await this.onBecomeLeader(cursor, this.stepDown, () => this.isActiveEpoch(epoch))
		} catch (error) {
			logger.error('[Leader] Failed to start leader work', undefined, { errorKind: errorKind(error) })
			await this.stepDown()
			return false
		}
		return this.isActiveEpoch(epoch)
	}

	private monotonicNow(): number {
		try {
			const supplied = this.dependencies.now?.()
			if (typeof supplied === 'number' && Number.isFinite(supplied)) return supplied
		} catch {
			// Fall back to the process monotonic clock if a test or optional clock
			// implementation fails. Never use wall-clock time for lease deadlines.
		}
		return performance.now()
	}

	private isActiveEpoch(epoch: number): boolean {
		return !this.signal.aborted && this.isLeader && epoch === this.leadershipEpoch
	}

	private leaseHasExpired(): boolean {
		return this.leaseDeadline !== null && this.monotonicNow() >= this.leaseDeadline
	}

	private checkLeaseDeadline(): void {
		if (this.isLeader && this.leaseHasExpired()) this.beginLeaseLoss()
	}

	private armLeaseDeadline(epoch: number): void {
		if (!this.isActiveEpoch(epoch) || this.leaseDeadline === null) return
		if (this.leaseDeadlineTimer) this.clearTimer(this.leaseDeadlineTimer)
		const remaining = this.leaseDeadline - this.monotonicNow()
		if (remaining <= 0) {
			this.beginLeaseLoss()
			return
		}
		this.leaseDeadlineTimer = this.scheduleTimer(
			() => {
				this.leaseDeadlineTimer = null
				if (!this.isActiveEpoch(epoch)) return
				if (this.leaseHasExpired()) this.beginLeaseLoss()
				else this.armLeaseDeadline(epoch)
			},
			Math.max(1, Math.ceil(remaining)),
		)
	}

	private scheduleRenewal(epoch: number): void {
		if (!this.isActiveEpoch(epoch) || this.leaseDeadline === null) return
		if (this.renewalTimer) this.clearTimer(this.renewalTimer)
		const remaining = this.leaseDeadline - this.monotonicNow()
		if (remaining <= 0) {
			this.beginLeaseLoss()
			return
		}
		const configuredInterval = Number.isSafeInteger(config.leaderRenewIntervalMs)
			? Math.max(1, config.leaderRenewIntervalMs)
			: Math.max(1, Math.floor(config.leaderTtlMs / 4))
		const delay = Math.min(configuredInterval, Math.max(1, Math.floor(remaining)))
		this.renewalTimer = this.scheduleTimer(() => {
			this.renewalTimer = null
			void this.renewLeadership(epoch)
		}, delay)
	}

	private async renewLeadership(epoch: number): Promise<void> {
		if (!this.isActiveEpoch(epoch) || this.renewalInFlightEpoch === epoch) return
		if (this.leaseHasExpired()) {
			this.beginLeaseLoss()
			return
		}

		this.renewalInFlightEpoch = epoch
		let renewed = false
		try {
			renewed = await this.tryRenewLeadership()
		} finally {
			if (this.renewalInFlightEpoch === epoch) this.renewalInFlightEpoch = null
		}
		if (!this.isActiveEpoch(epoch)) return
		if (this.leaseHasExpired()) {
			this.beginLeaseLoss()
			return
		}
		if (renewed) {
			// The response arrived before the old deadline. Start the next local
			// safety window from its receipt instead of trusting wall-clock time.
			this.leaseDeadline = this.monotonicNow() + leaseValidityWindowMs()
			this.armLeaseDeadline(epoch)
			this.scheduleRenewal(epoch)
			return
		}
		logger.warn('[Leader] Renewal failed before the lease deadline; retrying')
		this.scheduleRenewal(epoch)
	}

	private async tryRenewLeadership(): Promise<boolean> {
		try {
			return await this.dependencies.renewLeadership()
		} catch (error) {
			logger.error('[Leader] Renewal error', undefined, { errorKind: errorKind(error) })
			return false
		}
	}

	private beginLeaseLoss(): void {
		if (!this.isLeader) return
		logger.warn('[Leader] Lease safety deadline reached; stopping intake without waiting')
		this.relinquishLeadership()
		// If a voluntary step-down is already draining, share that exact promise
		// rather than invoking the stop callback twice.
		const drain = this.startLeadershipLoss()
		this.lostLeadershipDrain = drain
		void drain.then((drained) => {
			if (!drained) this.markTerminal('Leader election stopped after an unsafe leadership drain')
		})
	}

	private startLeadershipLoss(): Promise<boolean> {
		if (!this.leadershipLoss) this.leadershipLoss = this.safelyLoseLeadership()
		return this.leadershipLoss
	}

	private readonly stepDown = (): Promise<void> => {
		if (this.steppingDown) return this.steppingDown
		if (!this.isLeader) return Promise.resolve()

		this.steppingDown = this.drainThenRelease().finally(() => {
			this.steppingDown = null
		})
		return this.steppingDown
	}

	private async drainThenRelease(): Promise<void> {
		logger.warn('[Leader] Stepping down voluntarily after drain')
		// Renewal deliberately remains active during this await. The deadline
		// watchdog can still fence a hung drain or renewal independently.
		const drained = await this.startLeadershipLoss()
		const stillOwned = this.isLeader
		if (!stillOwned) return
		this.relinquishLeadership()
		if (!drained) {
			this.leaveLeaseToExpire()
			return
		}

		const released = await this.safelyReleaseLeadership()
		if (!released) {
			this.leaveLeaseToExpire()
			return
		}
		this.leadershipLoss = null
	}

	private relinquishLeadership(): void {
		this.clearRenewal()
		this.isLeader = false
		this.leadershipEpoch++
		this.leaseDeadline = null
	}

	private leaveLeaseToExpire(): void {
		this.markTerminal('Leader election stopped after a forced leadership drain')
		logger.error('[Leader] Drain was forced; leaving lease to expire instead of releasing it')
	}

	private async safelyReleaseLeadership(): Promise<boolean> {
		try {
			await this.dependencies.releaseLeadership()
			return true
		} catch (error) {
			logger.error('[Leader] Failed to release leader key', undefined, { errorKind: errorKind(error) })
			return false
		}
	}

	private async safelyLoseLeadership(): Promise<boolean> {
		try {
			return await this.onLoseLeadership()
		} catch (error) {
			logger.error('[Leader] Firehose stop failed', undefined, { errorKind: errorKind(error) })
			return false
		}
	}

	private markTerminal(message: string): void {
		if (this.terminalError) return
		this.terminalError = new Error(message)
		this.resolveTerminalWake?.()
		this.resolveTerminalWake = null
	}

	private readonly onAbort = (): void => {
		this.clearRenewal()
		this.leaseDeadline = null
		this.leadershipEpoch++
		if (this.steppingDown) {
			this.abortLoss = this.steppingDown
			return
		}
		if (this.isLeader) {
			this.isLeader = false
			const loss = this.startLeadershipLoss()
			this.abortLoss = loss.then((drained) => {
				if (!drained) this.markTerminal('Leader election stopped after an unsafe shutdown drain')
			})
			return
		}
		if (this.lostLeadershipDrain) this.abortLoss = this.lostLeadershipDrain.then(() => undefined)
	}

	private scheduleTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
		return this.dependencies.setTimeout?.(callback, delayMs) ?? setTimeout(callback, delayMs)
	}

	private clearTimer(timer: ReturnType<typeof setTimeout>): void {
		if (this.dependencies.clearTimeout) this.dependencies.clearTimeout(timer)
		else clearTimeout(timer)
	}

	private clearRenewal(): void {
		if (this.renewalTimer) this.clearTimer(this.renewalTimer)
		this.renewalTimer = null
		if (this.leaseDeadlineTimer) this.clearTimer(this.leaseDeadlineTimer)
		this.leaseDeadlineTimer = null
	}
}

/**
 * Run the leader election loop. A voluntary step-down retains renewal until
 * direct firehose work has drained, then releases the lock. A true renewal loss
 * stops intake immediately and relies on replay plus per-site locks for any
 * overlap with the new leader.
 */
export async function runLeaderElection(
	onBecomeLeader: LeadershipStartCallback,
	onLoseLeadership: LeadershipLossCallback,
	signal: AbortSignal,
	initialService: string,
	dependencies: LeaderElectionDependencies = defaultLeaderElectionDependencies,
): Promise<void> {
	await new LeaderElectionMachine(onBecomeLeader, onLoseLeadership, signal, initialService, dependencies).run()
}

export async function closeLeaderRedis(): Promise<void> {
	if (redis) {
		const toClose = redis
		redis = null
		redisConnectPromise = null
		try {
			await withRedisTimeout(toClose.quit(), redisOperationTimeoutMs(), 'Redis close')
		} catch {
			try {
				toClose.disconnect()
			} catch {
				// Closing is best effort after the bounded shutdown attempt.
			}
		}
	}
}
