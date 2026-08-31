import { createHash } from 'node:crypto'

export interface SupervisorConfig {
	readonly redisUrl: string
	readonly databaseUrl: string
	readonly redisLeaseKey: string
	readonly redisEpochKey: string
	readonly advisoryLockKey: string
	readonly advisoryLockId: bigint
	readonly leaseTtlMs: number
	readonly renewIntervalMs: number
	readonly pollIntervalMs: number
	readonly commandTimeoutMs: number
	readonly parentPid: number
	readonly watchdogPath: string | undefined
}

const DEFAULT_REDIS_LEASE_KEY = 'wisp:firehose-leader'
const DEFAULT_REDIS_EPOCH_KEY = 'wisp:firehose-leader-epoch'
const DEFAULT_ADVISORY_LOCK_KEY = 'wisp:firehose-leader'
const DEFAULT_LEASE_TTL_MS = 30_000
const DEFAULT_RENEW_INTERVAL_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_COMMAND_TIMEOUT_MS = 2_000
const NAME_PATTERN = /^[A-Za-z0-9:_./-]{1,256}$/
const INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/

/** A namespace-init PID cannot be SIGKILLed by its in-namespace supervisor. */
export function assertSignallableWorkerPid(pid: number): void {
	if (!Number.isSafeInteger(pid) || pid <= 1) {
		throw new Error('Leadership-supervised firehose worker must run below a real init process')
	}
}

export function supervisorAdvisoryLockId(key = DEFAULT_ADVISORY_LOCK_KEY): bigint {
	const digest = createHash('sha256').update(key).digest('hex')
	return BigInt(`0x${digest.slice(0, 16)}`) & 0x7fffffffffffffffn
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
	if (!value || !INTEGER_PATTERN.test(value)) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

function requiredUrl(
	value: string | undefined,
	field: string,
	protocols: readonly string[],
	forbidQuery = false,
): string {
	if (!value) throw new Error(`${field} is required`)
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error(`Invalid ${field}`)
	}
	if (!protocols.includes(url.protocol) || !url.hostname || url.hash || (forbidQuery && url.search)) {
		throw new Error(`Invalid ${field}`)
	}
	return value
}

function boundedName(value: string | undefined, fallback: string, field: string): string {
	const result = value ?? fallback
	if (!NAME_PATTERN.test(result)) throw new Error(`Invalid ${field}`)
	return result
}

function parseParentPid(value: string | undefined): number {
	if (!value || !INTEGER_PATTERN.test(value)) throw new Error('SUPERVISOR_PARENT_PID is required')
	const pid = Number(value)
	if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid SUPERVISOR_PARENT_PID')
	return pid
}

/** Resolve only the supervisor's authority configuration; no worker/S3 settings are read. */
export function resolveSupervisorConfig(
	environment: Record<string, string | undefined> = process.env,
	args: readonly string[] = process.argv,
): SupervisorConfig {
	const parentPidArgument = args.find((arg) => arg.startsWith('--parent-pid='))?.slice('--parent-pid='.length)
	const parentPid = parseParentPid(parentPidArgument ?? environment.SUPERVISOR_PARENT_PID)
	const redisUrl = requiredUrl(environment.REDIS_URL, 'REDIS_URL', ['redis:', 'rediss:'], true)
	const databaseUrl = requiredUrl(environment.DATABASE_URL, 'DATABASE_URL', ['postgres:', 'postgresql:'])
	const leaseTtlMs = boundedInteger(environment.LEADER_TTL_MS, DEFAULT_LEASE_TTL_MS, 1_000, 300_000)
	const configuredRenew = boundedInteger(environment.LEADER_RENEW_INTERVAL_MS, DEFAULT_RENEW_INTERVAL_MS, 100, 299_999)
	const renewIntervalMs = Math.min(configuredRenew, Math.max(100, Math.floor(leaseTtlMs / 2)))
	const commandTimeoutMs = boundedInteger(
		environment.SUPERVISOR_COMMAND_TIMEOUT_MS,
		DEFAULT_COMMAND_TIMEOUT_MS,
		50,
		30_000,
	)
	if (commandTimeoutMs >= leaseTtlMs) throw new Error('SUPERVISOR_COMMAND_TIMEOUT_MS must be below LEADER_TTL_MS')
	const redisLeaseKey = boundedName(
		environment.SUPERVISOR_REDIS_LEASE_KEY,
		DEFAULT_REDIS_LEASE_KEY,
		'SUPERVISOR_REDIS_LEASE_KEY',
	)
	const redisEpochKey = boundedName(
		environment.SUPERVISOR_REDIS_EPOCH_KEY,
		DEFAULT_REDIS_EPOCH_KEY,
		'SUPERVISOR_REDIS_EPOCH_KEY',
	)
	if (redisLeaseKey === redisEpochKey) throw new Error('SUPERVISOR_REDIS_LEASE_KEY and epoch key must differ')
	const watchdogPath =
		environment.FIREHOSE_WATCHDOG_PATH || environment.LEADERSHIP_WATCHDOG_PATH || environment.WATCHDOG_PATH || undefined
	return {
		redisUrl,
		databaseUrl,
		redisLeaseKey,
		redisEpochKey,
		advisoryLockKey: boundedName(
			environment.SUPERVISOR_ADVISORY_LOCK_KEY,
			DEFAULT_ADVISORY_LOCK_KEY,
			'SUPERVISOR_ADVISORY_LOCK_KEY',
		),
		advisoryLockId: supervisorAdvisoryLockId(environment.SUPERVISOR_ADVISORY_LOCK_KEY ?? DEFAULT_ADVISORY_LOCK_KEY),
		leaseTtlMs,
		renewIntervalMs,
		pollIntervalMs: boundedInteger(environment.LEADER_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, 100, 60_000),
		commandTimeoutMs,
		parentPid,
		watchdogPath,
	}
}
