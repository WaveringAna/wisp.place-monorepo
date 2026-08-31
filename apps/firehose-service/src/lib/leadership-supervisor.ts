import { createHash, randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import postgres from 'postgres'
import type { SupervisorConfig } from './supervisor-config'
import type { SupervisorCommand, SupervisorState, SupervisorStateMessage } from './supervisor-protocol'
import { SUPERVISOR_PROTOCOL_VERSION } from './supervisor-protocol'
import { createProcessWatchdog, type SupervisorWatchdog } from './watchdog'

/** All candidates acquire authority in this order: Redis lease, then Postgres lock. */
export const SUPERVISOR_LOCK_ORDER = ['redis-lease', 'postgres-primary-advisory-lock'] as const

export const ACQUIRE_LEASE_SCRIPT = `
if redis.call('set', KEYS[1], ARGV[1], 'NX', 'PX', tonumber(ARGV[2])) then
  return redis.call('incr', KEYS[2])
end
return 0
`

export const RENEW_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('set', KEYS[1], ARGV[1], 'XX', 'PX', tonumber(ARGV[2]))
end
return false
`

export const RELEASE_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

type MaybePromise<T> = T | PromiseLike<T>

export interface RedisLease {
	acquire(token: string, ttlMs: number, deadlineAt: number): MaybePromise<number | null>
	renew(token: string, ttlMs: number, deadlineAt: number): MaybePromise<boolean>
	release(token: string, deadlineAt: number): MaybePromise<boolean>
	close(): MaybePromise<void>
}

export interface PrimaryAdvisorySession {
	/** Verify primary/read-write state, then take the session-level advisory lock. */
	acquire(lockId: bigint, deadlineAt: number): MaybePromise<boolean>
	/** Verify the same backend session, role, primary state, and held lock. */
	verify(lockId: bigint, deadlineAt: number): MaybePromise<boolean>
	release(lockId: bigint, deadlineAt: number): MaybePromise<void>
	/** Drop an uncertain session so a partially acquired lock cannot survive. */
	reset(): MaybePromise<void>
	close(): MaybePromise<void>
}

export interface SupervisorDependencies {
	readonly redis: RedisLease
	readonly postgres: PrimaryAdvisorySession
	readonly now?: () => number
	readonly sleep?: (milliseconds: number) => Promise<void>
	readonly killParent?: (pid: number) => void
	readonly sendState?: (message: SupervisorStateMessage) => MaybePromise<void>
}

export interface LeadershipSupervisorOptions {
	readonly parentPid: number
	readonly redisLeaseKey: string
	readonly redisEpochKey: string
	readonly advisoryLockId: bigint
	readonly leaseTtlMs: number
	readonly renewIntervalMs: number
	readonly pollIntervalMs: number
	readonly commandTimeoutMs: number
	readonly instanceId?: string
	readonly watchdog?: SupervisorWatchdog
	readonly dependencies: SupervisorDependencies
}

export interface SupervisorRunResult {
	readonly exitCode: 0 | 1
	readonly state: SupervisorState
	readonly epoch?: number
}

export class SupervisorDeadlineError extends Error {
	constructor(operation: string) {
		super(`Supervisor ${operation} exceeded its deadline`)
		this.name = 'SupervisorDeadlineError'
	}
}

export class SupervisorInvariantError extends Error {
	constructor(reason: string) {
		super(`Supervisor invariant failed: ${reason}`)
		this.name = 'SupervisorInvariantError'
	}
}

function defaultNow(): number {
	return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function defaultKillParent(pid: number): void {
	try {
		process.kill(pid, 'SIGKILL')
	} catch (error) {
		// ESRCH means the parent has already gone away. Do not prevent authority
		// cleanup; any other error is still represented by the fatal exit state.
		if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
		throw error
	}
}

function errorKind(error: unknown): string {
	return error instanceof Error && error.name ? error.name : 'UnknownError'
}

/** Bound an adapter operation even when a dependency ignores its deadline argument. */
async function withDeadline<T>(
	operation: string,
	deadlineAt: number,
	now: () => number,
	work: () => MaybePromise<T>,
): Promise<T> {
	const remaining = deadlineAt - now()
	if (remaining <= 0) throw new SupervisorDeadlineError(operation)
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new SupervisorDeadlineError(operation)), remaining)
	})
	try {
		const result = await Promise.race([Promise.resolve().then(work), timeout])
		if (now() > deadlineAt) throw new SupervisorDeadlineError(operation)
		return result
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function boundedEpoch(value: unknown): number | null {
	const epoch = typeof value === 'string' ? Number(value) : value
	if (!Number.isSafeInteger(epoch) || (epoch as number) < 1) return null
	return epoch as number
}

/**
 * Dependency-injected supervisor state machine.
 *
 * The state machine deliberately does not run in the firehose worker. Its fatal path kills the
 * parent before releasing either authority, so a blocked parent callback cannot
 * continue firehose writes after another instance takes over.
 */
export class LeadershipSupervisor {
	private readonly parentPid: number
	private readonly redisLeaseKey: string
	private readonly redisEpochKey: string
	private readonly advisoryLockId: bigint
	private readonly leaseTtlMs: number
	private readonly renewIntervalMs: number
	private readonly pollIntervalMs: number
	private readonly commandTimeoutMs: number
	private readonly instanceId: string
	private readonly dependencies: SupervisorDependencies
	private readonly now: () => number
	private readonly sleep: (milliseconds: number) => Promise<void>
	private readonly killParent: (pid: number) => void
	private readonly sendState: (message: SupervisorStateMessage) => MaybePromise<void>
	private readonly watchdog: SupervisorWatchdog | undefined
	private state: SupervisorState = 'standby'
	private epoch: number | undefined
	private lastEpoch = 0
	private hasRedisLease = false
	private hasPostgresLock = false
	private releaseRequested = false
	private parentHandshakeReceived = false
	private terminal = false
	private fatalInFlight: Promise<void> | null = null
	private wakeResolver: (() => void) | null = null
	private watchdogStarted = false
	private announcedStandby = false

	constructor(options: LeadershipSupervisorOptions) {
		if (!Number.isSafeInteger(options.parentPid) || options.parentPid < 1) {
			throw new SupervisorInvariantError('invalid parent PID')
		}
		if (options.leaseTtlMs <= 0 || options.renewIntervalMs <= 0 || options.pollIntervalMs <= 0) {
			throw new SupervisorInvariantError('invalid supervisor intervals')
		}
		if (options.commandTimeoutMs <= 0 || options.commandTimeoutMs >= options.leaseTtlMs) {
			throw new SupervisorInvariantError('command deadline must be below lease TTL')
		}
		this.parentPid = options.parentPid
		this.redisLeaseKey = options.redisLeaseKey
		this.redisEpochKey = options.redisEpochKey
		this.advisoryLockId = options.advisoryLockId
		this.leaseTtlMs = options.leaseTtlMs
		this.renewIntervalMs = options.renewIntervalMs
		this.pollIntervalMs = options.pollIntervalMs
		this.commandTimeoutMs = options.commandTimeoutMs
		this.instanceId = options.instanceId ?? randomUUID()
		this.dependencies = options.dependencies
		this.now = options.dependencies.now ?? defaultNow
		this.sleep = options.dependencies.sleep ?? defaultSleep
		this.killParent = options.dependencies.killParent ?? defaultKillParent
		this.sendState = options.dependencies.sendState ?? (() => undefined)
		this.watchdog = options.watchdog
		this.watchdog?.onFailure?.(() => {
			void this.fail('watchdog process exited or lost its pipe')
		})
	}

	get currentState(): SupervisorState {
		return this.state
	}

	get currentEpoch(): number | undefined {
		return this.epoch
	}

	get ownsAuthority(): boolean {
		return this.hasRedisLease && this.hasPostgresLock
	}

	get id(): string {
		return this.instanceId
	}

	/** Receive a validated parent command. It never executes worker callbacks. */
	async handleCommand(command: SupervisorCommand): Promise<void> {
		if (this.terminal) return
		if (command.type === 'hello') {
			if (command.parentPid !== this.parentPid) {
				await this.fail('parent PID changed')
				return
			}
			this.parentHandshakeReceived = true
			return
		}
		if (!this.parentHandshakeReceived) {
			await this.fail('parent release arrived before handshake')
			return
		}
		this.releaseRequested = true
		this.wake()
	}

	/** Execute one independent supervisor tick. Useful for deterministic tests. */
	async tick(): Promise<void> {
		if (this.terminal) return
		if (this.releaseRequested) {
			await this.releaseVoluntarily()
			return
		}
		if (this.ownsAuthority) {
			await this.renewAuthority()
			return
		}
		await this.tryAcquire()
	}

	/** Run until a voluntary release or a fatal authority/IPC failure. */
	async run(): Promise<SupervisorRunResult> {
		if (this.watchdog) {
			try {
				this.watchdogStarted = true
				const deadline = this.now() + this.commandTimeoutMs
				await withDeadline('Watchdog start', deadline, this.now, () => this.watchdog?.start())
			} catch (error) {
				await this.fail(`watchdog startup failed (${errorKind(error)})`)
			}
		}
		if (this.terminal) {
			return {
				exitCode: 1,
				state: this.state,
				...(this.epoch === undefined ? {} : { epoch: this.epoch }),
			}
		}
		try {
			await this.announce('standby')
		} catch (error) {
			await this.fail(`initial state announcement failed (${errorKind(error)})`)
		}
		while (!this.terminal) {
			try {
				await this.tick()
			} catch (error) {
				await this.fail(`supervisor tick failed (${errorKind(error)})`)
			}
			if (this.terminal) break
			try {
				await this.wait(this.ownsAuthority ? this.renewIntervalMs : this.pollIntervalMs)
			} catch (error) {
				await this.fail(`supervisor timer failed (${errorKind(error)})`)
			}
		}
		if (this.fatalInFlight) await this.fatalInFlight
		return {
			exitCode: this.state === 'released' ? 0 : 1,
			state: this.state,
			...(this.epoch === undefined ? {} : { epoch: this.epoch }),
		}
	}

	/** Fail closed for protocol, timer, or adapter invariants detected by the CLI. */
	async failClosed(reason: string): Promise<void> {
		await this.fail(reason)
	}

	private async tryAcquire(): Promise<void> {
		const leaseDeadline = this.now() + this.commandTimeoutMs
		let epochValue: number | null
		try {
			epochValue = await withDeadline('Redis acquire', leaseDeadline, this.now, () =>
				this.dependencies.redis.acquire(this.instanceId, this.leaseTtlMs, leaseDeadline),
			)
		} catch (error) {
			if (error instanceof SupervisorInvariantError) {
				await this.fail(error.message)
				return
			}
			// No authority was obtained. Keep the worker a healthy standby while Redis
			// recovers; a lease command failure cannot permit worker startup.
			await this.announceStandby('redis-unavailable')
			return
		}
		if (epochValue === null) {
			await this.announceStandby()
			return
		}
		if (epochValue === undefined) {
			await this.fail('Redis returned no acquisition result')
			return
		}
		const epoch = boundedEpoch(epochValue)
		if (epoch === null) {
			await this.fail('Redis returned an invalid epoch')
			return
		}
		this.hasRedisLease = true
		let acquired = false
		try {
			const postgresDeadline = this.now() + this.commandTimeoutMs
			const acquisitionResult = await withDeadline('Postgres acquire', postgresDeadline, this.now, () =>
				this.dependencies.postgres.acquire(this.advisoryLockId, postgresDeadline),
			)
			if (typeof acquisitionResult !== 'boolean')
				throw new SupervisorInvariantError('Postgres returned an invalid acquisition result')
			acquired = acquisitionResult
		} catch {
			await this.discardPartialAuthority()
			await this.announceStandby('postgres-unavailable')
			return
		}
		if (!acquired) {
			await this.discardPartialAuthority()
			await this.announceStandby('postgres-not-primary-or-lock-held')
			return
		}
		this.hasPostgresLock = true
		if (epoch <= this.lastEpoch) {
			await this.fail('Redis epoch did not increase')
			return
		}
		this.lastEpoch = epoch
		this.epoch = epoch
		await this.announce('acquired')
	}

	private async renewAuthority(): Promise<void> {
		if (!this.ownsAuthority || this.epoch === undefined) {
			await this.fail('authority flags are inconsistent')
			return
		}
		const leaseDeadline = this.now() + this.commandTimeoutMs
		let renewed = false
		try {
			renewed = await withDeadline('Redis renew', leaseDeadline, this.now, () =>
				this.dependencies.redis.renew(this.instanceId, this.leaseTtlMs, leaseDeadline),
			)
		} catch {
			await this.fail('Redis lease deadline or connection failure')
			return
		}
		if (!renewed) {
			await this.fail('Redis lease lost')
			return
		}
		const postgresDeadline = this.now() + this.commandTimeoutMs
		let valid = false
		try {
			valid = await withDeadline('Postgres verify', postgresDeadline, this.now, () =>
				this.dependencies.postgres.verify(this.advisoryLockId, postgresDeadline),
			)
		} catch {
			await this.fail('Postgres session deadline or connection failure')
			return
		}
		if (!valid) await this.fail('Postgres primary, role, session, or advisory lock lost')
	}

	private async discardPartialAuthority(): Promise<void> {
		// If the PG command timed out after acquiring, reset first so a hidden
		// session-level lock cannot outlive the Redis lease we are about to drop.
		try {
			await withDeadline('Postgres reset', this.now() + this.commandTimeoutMs, this.now, () =>
				this.dependencies.postgres.reset(),
			)
		} catch {
			// reset() is a best effort before no authority has been advertised.
		}
		this.hasPostgresLock = false
		if (this.hasRedisLease) {
			try {
				await withDeadline('Redis release after failed acquire', this.now() + this.commandTimeoutMs, this.now, () =>
					this.dependencies.redis.release(this.instanceId, this.now() + this.commandTimeoutMs),
				)
			} catch {
				// The lease will expire. No worker has started, so this is still a
				// safe standby outcome.
			}
			this.hasRedisLease = false
		}
	}

	private async releaseVoluntarily(): Promise<void> {
		if (this.terminal) return
		// Confirm both authorities immediately before the reverse-order release.
		// This turns a lease that expired between ticks into the fatal kill path,
		// rather than discovering it only after dropping the PG lock.
		if (this.ownsAuthority) {
			await this.renewAuthority()
			if (this.terminal) return
		}
		this.terminal = true
		if (this.ownsAuthority) {
			try {
				await this.announce('releasing')
				await this.releaseAuthority()
				await this.closeDependencies(true)
				this.state = 'released'
				await this.announce('released')
			} catch (error) {
				// The parent has already drained. Still fail closed if authority
				// cannot be proven released.
				this.terminal = false
				await this.fail(`graceful release failed (${errorKind(error)})`)
			}
			return
		}
		try {
			// A standby has no worker activity, but its watchdog still needs an
			// explicit release acknowledgement. Closing the pipe would treat normal
			// shutdown as supervisor loss and SIGKILL the parent.
			await this.closeDependencies(true)
			this.state = 'released'
			await this.announce('released')
		} catch {
			this.terminal = false
			await this.fail('standby close failed')
		}
	}

	private async releaseAuthority(): Promise<void> {
		let firstError: unknown
		if (this.hasPostgresLock) {
			try {
				const deadline = this.now() + this.commandTimeoutMs
				await withDeadline('Postgres release', deadline, this.now, () =>
					this.dependencies.postgres.release(this.advisoryLockId, deadline),
				)
			} catch (error) {
				firstError = error
			} finally {
				this.hasPostgresLock = false
			}
		}
		if (this.hasRedisLease) {
			try {
				const deadline = this.now() + this.commandTimeoutMs
				const released = await withDeadline('Redis release', deadline, this.now, () =>
					this.dependencies.redis.release(this.instanceId, deadline),
				)
				if (released === false) throw new SupervisorInvariantError('Redis release was not confirmed')
			} catch (error) {
				firstError ??= error
			} finally {
				this.hasRedisLease = false
			}
		}
		if (firstError) throw firstError
	}

	private async closeDependencies(graceful = false): Promise<void> {
		await Promise.all([this.dependencies.redis.close(), this.dependencies.postgres.close()])
		if (!this.watchdog || !this.watchdogStarted) return
		if (graceful) {
			const deadline = this.now() + this.commandTimeoutMs
			await withDeadline('Watchdog release', deadline, this.now, () => this.watchdog?.stop())
			this.watchdogStarted = false
			return
		}
		this.watchdogStarted = false
		// EOF is intentional here: the watchdog kills the worker if the fatal kill above
		// was interrupted or raced an OS process failure.
		await this.watchdog.close()
	}

	private async fail(reason: string): Promise<void> {
		if (this.fatalInFlight) return await this.fatalInFlight
		this.wake()
		this.fatalInFlight = (async () => {
			this.terminal = true
			this.state = 'fatal'
			try {
				await this.announce('fatal', reason)
			} catch {
				// A broken output pipe is itself an IPC loss. Killing the worker below is
				// still mandatory even when the diagnostic state cannot be written.
			}
			// This order is a safety invariant: kill the worker before releasing either
			// authority, regardless of whether the kill syscall reports ESRCH.
			try {
				this.killParent(this.parentPid)
			} catch {
				// Continue cleanup and return a nonzero result from the CLI.
			}
			try {
				await this.releaseAuthority()
			} catch {
				// A lost authority is intentionally not allowed to block supervisor exit.
			}
			try {
				await this.closeDependencies()
			} catch {
				// Exit remains nonzero.
			}
		})()
		await this.fatalInFlight
	}

	private async announce(state: SupervisorState, reason?: string): Promise<void> {
		this.state = state
		if (state === 'standby') this.announcedStandby = true
		const message: SupervisorStateMessage = {
			version: SUPERVISOR_PROTOCOL_VERSION,
			type: 'state',
			state,
			pid: process.pid,
			...(this.epoch === undefined ? {} : { epoch: this.epoch }),
			...(reason ? { reason } : {}),
		}
		await this.sendState(message)
	}

	private async announceStandby(reason?: string): Promise<void> {
		if (this.state === 'standby' && this.announcedStandby && !reason) return
		await this.announce('standby', reason)
	}

	private wake(): void {
		const resolve = this.wakeResolver
		this.wakeResolver = null
		resolve?.()
	}

	private async wait(milliseconds: number): Promise<void> {
		if (this.terminal || this.releaseRequested) return
		const wake = new Promise<void>((resolve) => {
			this.wakeResolver = resolve
		})
		try {
			await Promise.race([this.sleep(milliseconds), wake])
		} finally {
			this.wakeResolver = null
		}
	}
}

/** Construct production adapters. The supervisor binary is the only caller. */
export function createRedisLease(
	config: Pick<SupervisorConfig, 'redisUrl' | 'redisLeaseKey' | 'redisEpochKey' | 'commandTimeoutMs'>,
): RedisLease {
	const client = new Redis(config.redisUrl, {
		lazyConnect: true,
		maxRetriesPerRequest: 0,
		enableReadyCheck: true,
		enableOfflineQueue: false,
		connectTimeout: config.commandTimeoutMs,
	})
	return {
		acquire: async (token, ttlMs) => {
			const result = await client.eval(
				ACQUIRE_LEASE_SCRIPT,
				2,
				config.redisLeaseKey,
				config.redisEpochKey,
				token,
				String(ttlMs),
			)
			if (result === 0 || result === '0' || result === null) return null
			const epoch = boundedEpoch(result)
			if (epoch === null) throw new SupervisorInvariantError('Redis returned an invalid epoch')
			return epoch
		},
		renew: async (token, ttlMs) => {
			const result = await client.eval(RENEW_LEASE_SCRIPT, 1, config.redisLeaseKey, token, String(ttlMs))
			return result === 'OK'
		},
		release: async (token) => {
			const result = await client.eval(RELEASE_LEASE_SCRIPT, 1, config.redisLeaseKey, token)
			return result === 1 || result === '1'
		},
		close: () => {
			client.disconnect()
		},
	}
}

export function createPrimaryAdvisorySession(
	config: Pick<SupervisorConfig, 'databaseUrl' | 'commandTimeoutMs'>,
): PrimaryAdvisorySession {
	let client = postgres(config.databaseUrl, {
		max: 1,
		idle_timeout: 0,
		max_lifetime: null,
		connect_timeout: Math.max(1, Math.ceil(config.commandTimeoutMs / 1000)),
	})
	let closed = false
	let backendPid: number | undefined
	let roleName: string | undefined
	let held = false

	return {
		acquire: async (lockId) => {
			const primary = await client<
				Array<{
					in_recovery: boolean
					transaction_read_only: string
					backend_pid: number
					role_name: string
					role_valid: boolean
				}>
			>`
				SELECT pg_is_in_recovery() AS in_recovery,
				       current_setting('transaction_read_only') AS transaction_read_only,
				       pg_backend_pid() AS backend_pid,
				       current_user AS role_name,
				       has_database_privilege(current_user, current_database(), 'CONNECT') AS role_valid
			`
			const row = primary[0]
			if (!row || row.in_recovery || row.transaction_read_only !== 'off' || !row.role_valid) return false
			const lockResult = await client.unsafe<Array<{ locked: boolean }>>(
				`SELECT pg_try_advisory_lock(${lockId.toString()}::bigint) AS locked`,
			)
			if (!lockResult[0]?.locked) return false
			backendPid = Number(row.backend_pid)
			roleName = row.role_name
			held = true
			return true
		},
		verify: async (lockId) => {
			if (!held || backendPid === undefined || roleName === undefined) return false
			const lockNumber = lockId.toString()
			const rows = await client.unsafe<
				Array<{
					in_recovery: boolean
					transaction_read_only: string
					backend_pid: number
					role_name: string
					role_valid: boolean
					lock_held: boolean
				}>
			>(
				`SELECT pg_is_in_recovery() AS in_recovery,
				        current_setting('transaction_read_only') AS transaction_read_only,
				        pg_backend_pid() AS backend_pid,
				        current_user AS role_name,
				        has_database_privilege(current_user, current_database(), 'CONNECT') AS role_valid,
				        EXISTS (
				          SELECT 1 FROM pg_locks
				          WHERE pid = pg_backend_pid()
				            AND locktype = 'advisory'
				            AND granted
				            -- bigint advisory locks use objsubid=1; objsubid=2 is
				            -- reserved for the two-int-key API.
				            AND objsubid = 1
				            AND ((classid::bigint << 32) | objid::bigint) = ${lockNumber}::bigint
				        ) AS lock_held`,
			)
			const row = rows[0]
			return Boolean(
				row &&
					!row.in_recovery &&
					row.transaction_read_only === 'off' &&
					Number(row.backend_pid) === backendPid &&
					row.role_name === roleName &&
					row.role_valid &&
					row.lock_held,
			)
		},
		release: async (lockId) => {
			if (!held) return
			const result = await client.unsafe<Array<{ unlocked: boolean }>>(
				`SELECT pg_advisory_unlock(${lockId.toString()}::bigint) AS unlocked`,
			)
			if (!result[0]?.unlocked) throw new Error('Postgres advisory unlock was not confirmed')
			held = false
		},
		reset: async () => {
			held = false
			backendPid = undefined
			roleName = undefined
			await client.end({ timeout: 0 })
			if (!closed) {
				client = postgres(config.databaseUrl, {
					max: 1,
					idle_timeout: 0,
					max_lifetime: null,
					connect_timeout: Math.max(1, Math.ceil(config.commandTimeoutMs / 1000)),
				})
			}
		},
		close: async () => {
			closed = true
			await client.end({ timeout: config.commandTimeoutMs / 1000 })
		},
	}
}

export function createProductionSupervisor(
	config: SupervisorConfig,
	sendState: (message: SupervisorStateMessage) => MaybePromise<void>,
): LeadershipSupervisor {
	const watchdog = createProcessWatchdog({
		workerPid: config.parentPid,
		executable: config.watchdogPath,
	})
	return new LeadershipSupervisor({
		parentPid: config.parentPid,
		redisLeaseKey: config.redisLeaseKey,
		redisEpochKey: config.redisEpochKey,
		advisoryLockId: config.advisoryLockId,
		leaseTtlMs: config.leaseTtlMs,
		renewIntervalMs: config.renewIntervalMs,
		pollIntervalMs: config.pollIntervalMs,
		commandTimeoutMs: config.commandTimeoutMs,
		watchdog,
		dependencies: {
			redis: createRedisLease(config),
			postgres: createPrimaryAdvisorySession(config),
			sendState,
		},
	})
}

export function advisoryLockIdForName(name: string): bigint {
	const digest = createHash('sha256').update(name).digest('hex')
	return BigInt(`0x${digest.slice(0, 16)}`) & 0x7fffffffffffffffn
}
