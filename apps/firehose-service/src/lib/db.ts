import { createHash } from 'node:crypto'
import { DELETED_SITE_RECORD_CID } from '@wispplace/constants'
import type { SiteCache, SiteSettingsCache } from '@wispplace/database'
import { createLogger } from '@wispplace/observability'
import postgres from 'postgres'
import { config } from '../config'

const logger = createLogger('firehose-service')

const sql = postgres(config.databaseUrl, {
	max: 10,
	idle_timeout: 20,
	connect_timeout: 10,
})

/**
 * Dedicated pool for advisory locks.
 *
 * A site-write lock is held for the entire duration of a site sync, which
 * includes minutes of blob downloads. Holding those long-lived locks on the
 * main query pool would starve ordinary queries (the connection-pooling
 * starvation class of bug). Each slot is a one-connection postgres client, so
 * it remains pinned for the holder and can be physically closed on quarantine.
 * While a slot is held its session is kept alive by lock heartbeats (see
 * withReservedSiteWriteLock) so proxies cannot idle-kill it mid-sync.
 */
const LOCK_POOL_SIZE = 10
/** A reserve must never wait forever for a leaked or wedged lock holder. */
export const LOCK_POOL_RESERVE_TIMEOUT_MS = 30_000
/**
 * Grace period, in seconds, before a retiring lock-pool root client
 * force-destroys its sockets. postgres.js defers sub-1KiB protocol writes
 * through `setImmediate` and schedules writes without re-checking the socket,
 * so its immediate-destroy path (`end({ timeout: 0 })`) can race or follow a
 * cleared socket and crash the process with an uncaught `socket.write`
 * TypeError outside every Promise rejection (observed at postgres@3.4.9
 * connection.js:255 on Bun 1.3.14; no fixed release exists upstream). A
 * positive timeout lets the driver's graceful end path settle queued writes
 * first, while `end` still resolves within the bound because postgres.js
 * force-destroys sockets after the timeout. Quarantined advisory-lock sessions
 * therefore still physically close.
 */
export const LOCK_POOL_RETIRE_TIMEOUT_SECONDS = 1
/**
 * Bound on how long a blocked advisory-lock acquisition may wait. Proxies in
 * front of PostgreSQL idle-kill sessions after 60s without traffic, and a
 * blocked acquisition cannot heartbeat on its own session, so any wait beyond
 * that bound would die as CONNECTION_CLOSED anyway; failing at 45s keeps the
 * failure a clean, retryable lock timeout.
 */
export const LOCK_ACQUIRE_LOCK_TIMEOUT = '45s'
/**
 * Interval between liveness probes sent on a reserved advisory-lock session
 * while the lock callback runs. Proxies in front of PostgreSQL idle-kill
 * sessions after 60s without traffic, and a lock callback legitimately stays
 * idle for minutes while blobs download; a probe well below that bound keeps
 * the session (and therefore the session-scoped advisory lock) alive.
 */
export const LOCK_HEARTBEAT_INTERVAL_MS = 15_000
/**
 * A liveness probe that cannot complete within this bound means the lock
 * session (and with it the advisory lock) must be presumed lost.
 */
export const LOCK_HEARTBEAT_TIMEOUT_MS = 10_000

interface SiteWriteLockQuery<T = unknown> extends PromiseLike<T> {
	/** postgres.js exposes this on pending queries to send a cancel request. */
	cancel?: () => unknown
}

export interface SiteWriteLockReservedClient {
	(strings: TemplateStringsArray, ...values: unknown[]): SiteWriteLockQuery<unknown>
	release(): void
}

export interface SiteWriteLockPoolClient {
	reserve(): Promise<SiteWriteLockReservedClient>
	end(options: { timeout: number }): Promise<void>
}

const createSiteWriteLockPoolClient = (): SiteWriteLockPoolClient =>
	postgres(config.databaseUrl, {
		max: 1,
		// A reserved session can be intentionally idle while files download. Do
		// not let the driver drop its session-scoped advisory lock in that gap.
		idle_timeout: 0,
		max_lifetime: null,
		connect_timeout: 10,
	}) as unknown as SiteWriteLockPoolClient

export interface SiteWriteLockConnection {
	(strings: TemplateStringsArray, ...values: unknown[]): SiteWriteLockQuery<unknown>
	release(): void
	close(options: { timeout: number }): Promise<void>
}

interface LockPoolWaiter {
	resolve(connection: SiteWriteLockConnection): void
	reject(error: Error): void
	active: boolean
	deadline: number
	timer: ReturnType<typeof setTimeout>
	settled: boolean
	signal?: AbortSignal
	abortListener?: () => void
}

interface SiteWriteLockPoolOptions {
	/** Number of one-connection postgres clients kept in this pool. */
	size?: number
	/** Maximum time spent waiting for a reserved slot/session. */
	reserveTimeoutMs?: number
	/** Test seam; production creates a max=1 postgres client. */
	createClient?: () => SiteWriteLockPoolClient
}

/**
 * A bounded pool of reserved postgres sessions.
 *
 * The object returned to a lock holder is a small forwarding wrapper. It is
 * deliberately not the postgres client itself: postgres.js owns its `release`
 * method and its root client can be ended when a session is quarantined.
 */
interface LockPoolSlot {
	client: SiteWriteLockPoolClient
	endPromise: Promise<void> | null
}

interface LockPoolDirectActivation {
	settled: boolean
	reject(error: Error): void
	abortListener?: () => void
}

export class SiteWriteLockPool {
	private readonly slots = new Set<LockPoolSlot>()
	private readonly retiring = new Set<LockPoolSlot>()
	private readonly available: LockPoolSlot[] = []
	private readonly waiters: LockPoolWaiter[] = []
	private readonly assignedWaiters = new Set<LockPoolWaiter>()
	private readonly directActivations = new Set<LockPoolDirectActivation>()
	private readonly size: number
	private readonly reserveTimeoutMs: number
	private readonly createClientFactory: () => SiteWriteLockPoolClient
	private ending: Promise<void> | null = null
	private closed = false

	constructor(options: SiteWriteLockPoolOptions = {}) {
		const size = options.size ?? LOCK_POOL_SIZE
		this.size = Number.isSafeInteger(size) && size > 0 ? size : LOCK_POOL_SIZE
		const reserveTimeoutMs = options.reserveTimeoutMs ?? LOCK_POOL_RESERVE_TIMEOUT_MS
		this.reserveTimeoutMs =
			Number.isFinite(reserveTimeoutMs) && reserveTimeoutMs >= 0 ? reserveTimeoutMs : LOCK_POOL_RESERVE_TIMEOUT_MS
		this.createClientFactory = options.createClient ?? createSiteWriteLockPoolClient
	}

	reserve(signal?: AbortSignal): Promise<SiteWriteLockConnection> {
		if (this.closed) return Promise.reject(new Error('Site write lock pool is closed'))
		if (signal?.aborted) return Promise.reject(abortReason(signal))

		const deadline = Date.now() + this.reserveTimeoutMs
		const slot = this.available.pop()
		if (slot) return this.activateForCaller(slot, deadline, signal)

		if (this.slots.size < this.size) {
			try {
				return this.activateForCaller(this.createSlot(), deadline, signal)
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error('Failed to create lock client'))
			}
		}

		return new Promise<SiteWriteLockConnection>((resolve, reject) => {
			const waiter = {} as LockPoolWaiter
			waiter.resolve = resolve
			waiter.reject = reject
			waiter.active = true
			waiter.deadline = deadline
			waiter.settled = false
			waiter.signal = signal
			waiter.timer = this.startWaiterTimer(waiter)
			if (signal) {
				waiter.abortListener = () => this.abortWaiter(waiter, abortReason(signal))
				signal.addEventListener('abort', waiter.abortListener, { once: true })
			}
			this.waiters.push(waiter)
			if (signal?.aborted) this.abortWaiter(waiter, abortReason(signal))
		})
	}

	end(options: { timeout: number }): Promise<void> {
		if (this.ending) return this.ending

		this.closed = true
		const closeError = new Error('Site write lock pool is closed')
		for (const waiter of this.waiters.splice(0)) this.settleWaiter(waiter, closeError)
		for (const waiter of this.assignedWaiters) {
			this.assignedWaiters.delete(waiter)
			this.settleWaiter(waiter, closeError)
		}
		for (const activation of this.directActivations) activation.reject(closeError)

		// Keep every slot tracked until its physical root client has ended. This
		// includes available, leased, and already-retiring/quarantined sessions.
		const slots = [...this.slots]
		this.ending = Promise.all(slots.map((slot) => this.retire(slot, options, false))).then(() => undefined)
		return this.ending
	}

	private createSlot(): LockPoolSlot {
		const slot = { client: this.createClientFactory(), endPromise: null }
		this.slots.add(slot)
		return slot
	}

	private activateForCaller(
		slot: LockPoolSlot,
		deadline: number,
		signal?: AbortSignal,
	): Promise<SiteWriteLockConnection> {
		return new Promise<SiteWriteLockConnection>((resolve, reject) => {
			const activation: LockPoolDirectActivation = {
				settled: false,
				reject: (error) => {
					if (activation.settled) return
					activation.settled = true
					if (signal && activation.abortListener) signal.removeEventListener('abort', activation.abortListener)
					activation.abortListener = undefined
					reject(error)
				},
			}
			this.directActivations.add(activation)
			if (signal) {
				activation.abortListener = () => activation.reject(abortReason(signal))
				signal.addEventListener('abort', activation.abortListener, { once: true })
			}
			void this.activate(slot, deadline, signal).then(
				(connection) => {
					this.directActivations.delete(activation)
					if (signal && activation.abortListener) signal.removeEventListener('abort', activation.abortListener)
					if (activation.settled || this.closed) {
						void connection.close({ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }).catch(() => undefined)
						return
					}
					activation.settled = true
					resolve(connection)
				},
				(error) => {
					this.directActivations.delete(activation)
					if (signal && activation.abortListener) signal.removeEventListener('abort', activation.abortListener)
					if (activation.settled) return
					activation.settled = true
					reject(error instanceof Error ? error : new Error('Failed to reserve lock client'))
				},
			)
		})
	}

	private activate(slot: LockPoolSlot, deadline: number, signal?: AbortSignal): Promise<SiteWriteLockConnection> {
		const timeoutMs = Math.max(0, deadline - Date.now())
		return this.reserveClient(slot.client, timeoutMs, signal)
			.then((reserved) => {
				if (this.closed || this.retiring.has(slot)) {
					try {
						reserved.release()
					} catch {
						// The root client is being retired below.
					}
					void this.retire(slot, { timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }).catch(() => undefined)
					throw new Error('Site write lock pool is closed')
				}
				return this.reservation(slot, reserved)
			})
			.catch((error) => {
				// Retirement is tracked separately so a reserve timeout remains
				// bounded even when closing the physical root is slow.
				if (!this.retiring.has(slot))
					void this.retire(slot, { timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }).catch(() => undefined)
				throw error
			})
	}

	private reserveClient(
		client: SiteWriteLockPoolClient,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<SiteWriteLockReservedClient> {
		if (signal?.aborted) return Promise.reject(abortReason(signal))
		let pending: Promise<SiteWriteLockReservedClient>
		try {
			pending = Promise.resolve(client.reserve())
		} catch (error) {
			return Promise.reject(error)
		}

		return new Promise<SiteWriteLockReservedClient>((resolve, reject) => {
			let settled = false
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				cleanup()
				reject(new Error('Timed out reserving site write lock connection'))
				releaseWhenReady()
			}, timeoutMs)
			;(timer as unknown as { unref?: () => void }).unref?.()
			const cleanup = () => {
				clearTimeout(timer)
				if (signal) signal.removeEventListener('abort', onAbort)
			}
			const releaseWhenReady = () => {
				// A driver reserve can still resolve after our bound. Release that
				// wrapper rather than leaving the physical session pinned.
				void pending.then(
					(reserved) => {
						try {
							reserved.release()
						} catch {
							// The root client is being retired by activate's rejection path.
						}
					},
					() => undefined,
				)
			}
			const onAbort = () => {
				if (settled) return
				settled = true
				cleanup()
				reject(abortReason(signal as AbortSignal))
				releaseWhenReady()
			}
			if (signal) signal.addEventListener('abort', onAbort, { once: true })
			pending.then(
				(reserved) => {
					if (settled) return
					settled = true
					cleanup()
					resolve(reserved)
				},
				(error) => {
					if (settled) return
					settled = true
					cleanup()
					reject(error)
				},
			)
			if (signal?.aborted) onAbort()
		})
	}

	private reservation(slot: LockPoolSlot, reserved: SiteWriteLockReservedClient): SiteWriteLockConnection {
		let finished = false
		// Forward queries through a new function object. Do not attach lifecycle
		// methods to either postgres.js object; the driver uses those methods to
		// manage its own connection queues.
		const connection = ((strings: TemplateStringsArray, ...values: unknown[]) =>
			reserved(strings, ...values)) as SiteWriteLockConnection

		connection.release = () => {
			if (finished) return
			finished = true
			try {
				reserved.release()
			} catch (error) {
				// A release failure leaves session state uncertain just like an unlock
				// failure. Quarantine this one slot and continue dispatching waiters.
				void this.retire(slot, { timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }).catch(() => undefined)
				logger.error('[DB] Failed to release reserved site-write connection', undefined, {
					errorKind: databaseErrorKind(error),
				})
				return
			}
			this.returnSlot(slot)
		}

		connection.close = async (options): Promise<void> => {
			if (finished) return
			finished = true
			await this.retire(slot, options)
		}

		return connection
	}

	private startWaiterTimer(waiter: LockPoolWaiter): ReturnType<typeof setTimeout> {
		const remaining = Math.max(0, waiter.deadline - Date.now())
		const timer = setTimeout(() => this.expireWaiter(waiter), remaining)
		;(timer as unknown as { unref?: () => void }).unref?.()
		return timer
	}

	private clearWaiterAbortListener(waiter: LockPoolWaiter): void {
		if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener('abort', waiter.abortListener)
		waiter.abortListener = undefined
	}

	private settleWaiter(waiter: LockPoolWaiter, error: Error): void {
		if (waiter.settled) return
		waiter.active = false
		waiter.settled = true
		clearTimeout(waiter.timer)
		this.clearWaiterAbortListener(waiter)
		waiter.reject(error)
	}

	private abortWaiter(waiter: LockPoolWaiter, error: Error): void {
		if (waiter.settled) return
		const index = this.waiters.indexOf(waiter)
		if (index >= 0) this.waiters.splice(index, 1)
		this.assignedWaiters.delete(waiter)
		this.settleWaiter(waiter, error)
	}

	private expireWaiter(waiter: LockPoolWaiter): void {
		if (!waiter.active) return
		const index = this.waiters.indexOf(waiter)
		if (index >= 0) this.waiters.splice(index, 1)
		this.settleWaiter(waiter, new Error('Timed out waiting for a site write lock connection'))
	}

	private takeWaiter(clearTimer: boolean): LockPoolWaiter | undefined {
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift()
			if (!waiter?.active) continue
			waiter.active = false
			if (clearTimer) clearTimeout(waiter.timer)
			return waiter
		}
		return undefined
	}

	private returnSlot(slot: LockPoolSlot): void {
		if (this.closed || this.retiring.has(slot)) return
		const waiter = this.takeWaiter(true)
		if (waiter) {
			this.assignSlot(slot, waiter)
			return
		}
		this.available.push(slot)
	}

	private assignSlot(slot: LockPoolSlot, waiter: LockPoolWaiter): void {
		clearTimeout(waiter.timer)
		if (waiter.deadline <= Date.now()) {
			this.settleWaiter(waiter, new Error('Timed out waiting for a site write lock connection'))
			void this.retire(slot, { timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }).catch(() => undefined)
			return
		}
		this.assignedWaiters.add(waiter)
		void this.activate(slot, waiter.deadline, waiter.signal).then(
			(connection) => {
				this.assignedWaiters.delete(waiter)
				if (waiter.settled || this.closed) {
					this.clearWaiterAbortListener(waiter)
					void connection.close({ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS }).catch(() => undefined)
					return
				}
				waiter.settled = true
				this.clearWaiterAbortListener(waiter)
				waiter.resolve(connection)
			},
			(error) => {
				this.assignedWaiters.delete(waiter)
				if (waiter.settled) return
				this.settleWaiter(waiter, error instanceof Error ? error : new Error('Failed to reserve lock client'))
				this.dispatch()
			},
		)
	}

	private removeAvailableSlot(slot: LockPoolSlot): void {
		const index = this.available.indexOf(slot)
		if (index >= 0) this.available.splice(index, 1)
	}

	private retire(slot: LockPoolSlot, options: { timeout: number }, dispatch = true): Promise<void> {
		if (slot.endPromise) return slot.endPromise
		this.retiring.add(slot)
		this.removeAvailableSlot(slot)
		slot.endPromise = Promise.resolve()
			.then(() => slot.client.end(options))
			.finally(() => {
				this.slots.delete(slot)
				this.retiring.delete(slot)
				if (dispatch && !this.closed) this.dispatch()
			})
		return slot.endPromise
	}

	private dispatch(): void {
		if (this.closed) return

		while (this.waiters.length > 0) {
			const waiter = this.takeWaiter(false)
			if (!waiter) continue

			let slot = this.available.pop()
			if (!slot) {
				if (this.slots.size >= this.size) {
					// No slot is currently available. Put this live waiter back without
					// resetting its original deadline.
					waiter.active = true
					this.waiters.unshift(waiter)
					return
				}
				try {
					slot = this.createSlot()
				} catch (error) {
					waiter.reject(error instanceof Error ? error : new Error('Failed to create lock client'))
					continue
				}
			}

			this.assignSlot(slot, waiter)
		}
	}
}

const lockPool = new SiteWriteLockPool()

/**
 * The unified per-site write-lock key. Shared verbatim with other cache
 * writers so all writers to a site's cache mutually exclude.
 */
function siteWriteLockKey(did: string, rkey: string): string {
	return `site-write:${did}:${rkey}`
}

/**
 * Derive the signed 63-bit PostgreSQL advisory-lock id without converting it
 * through JavaScript Number, which would lose high bits above 2^53 - 1.
 */
export function siteWriteLockId(did: string, rkey: string): bigint {
	const hash = createHash('sha256').update(siteWriteLockKey(did, rkey)).digest('hex')
	return BigInt(`0x${hash.substring(0, 16)}`) & 0x7fffffffffffffffn
}

function databaseErrorKind(error: unknown): string {
	if (!(error instanceof Error)) return 'UnknownError'
	return error.constructor.name || 'Error'
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error('Site write lock aborted')
}

/**
 * Execute one lock-acquisition query with postgres.js cancellation. The query
 * starts only after the preflight check, and an abort rejects immediately even
 * when a minimal test seam does not expose `.cancel()`; the caller then closes
 * the reserved session instead of returning a possibly lock-owning connection.
 */
function runCancellableLockQuery<T>(start: () => SiteWriteLockQuery<T>, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) return Promise.reject(abortReason(signal))
	let query: SiteWriteLockQuery<T>
	try {
		query = start()
	} catch (error) {
		return Promise.reject(error)
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false
		const cleanup = () => {
			if (signal) signal.removeEventListener('abort', onAbort)
		}
		const finish = (callback: () => void) => {
			if (settled) return
			settled = true
			cleanup()
			callback()
		}
		const onAbort = () => {
			if (settled) return
			try {
				const cancellation = query.cancel?.()
				if (cancellation) void Promise.resolve(cancellation).catch(() => undefined)
			} catch {
				// The reserved connection is closed by the caller below.
			}
			finish(() => reject(abortReason(signal as AbortSignal)))
		}
		if (signal) signal.addEventListener('abort', onAbort, { once: true })
		Promise.resolve(query).then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		)
		if (signal?.aborted) onAbort()
	})
}

/** postgres.js decodes a boolean result as `true`; anything else is unsafe. */
function advisoryUnlockReturnedTrue(result: unknown): boolean {
	if (!Array.isArray(result) || result.length === 0) return false
	const row = result[0]
	if (typeof row !== 'object' || row === null) return false
	const value =
		(row as { unlocked?: unknown; pg_advisory_unlock?: unknown }).unlocked ??
		(row as { pg_advisory_unlock?: unknown }).pg_advisory_unlock
	return value === true
}

export class SiteWriteLockAcquisitionError extends Error {
	readonly errorKind: string

	constructor(cause: unknown) {
		super('Failed to acquire site-write lock')
		this.name = 'SiteWriteLockAcquisitionError'
		this.errorKind = databaseErrorKind(cause)
	}
}

/**
 * The advisory-lock session died while the lock callback was running, so the
 * session-scoped lock was released by the server and mutual exclusion can no
 * longer be guaranteed. The callback receives an aborting signal the moment the
 * loss is detected; this error means its writes after that point may have raced
 * with another writer and the work should be retried.
 */
export class SiteWriteLockLostError extends Error {
	readonly errorKind: string

	constructor(cause: unknown) {
		super('Site write lock session was lost while the callback ran')
		this.name = 'SiteWriteLockLostError'
		this.errorKind = databaseErrorKind(cause)
	}
}

/** Liveness-probe tuning for a held site-write lock; production uses the defaults. */
export interface LockHeartbeatOptions {
	/** Interval between probes; defaults to {@link LOCK_HEARTBEAT_INTERVAL_MS}. */
	intervalMs?: number
	/** A probe slower than this bound presumes the lock session is lost. */
	timeoutMs?: number
}

interface LockHeartbeatMonitor {
	stop(): void
}

/**
 * Probe the reserved session on a fixed interval while a lock callback runs.
 * Each probe is an ordinary query on the same session; anything but a prompt
 * success means the session — and with it the session-scoped advisory lock —
 * must be presumed lost. Probes are crash-safe only because the patched
 * postgres.js rejects queries on a closed socket instead of throwing inside a
 * `setImmediate` write callback (see patches/postgres@3.4.9.patch).
 */
function startLockHeartbeat(
	conn: SiteWriteLockConnection,
	options: LockHeartbeatOptions,
	onLost: (error: unknown) => void,
): LockHeartbeatMonitor {
	const intervalMs = options.intervalMs ?? LOCK_HEARTBEAT_INTERVAL_MS
	const timeoutMs = options.timeoutMs ?? LOCK_HEARTBEAT_TIMEOUT_MS
	let timer: ReturnType<typeof setInterval> | null = null
	let probing = false
	let stopped = false
	const tick = () => {
		if (stopped || probing) return
		probing = true
		const timeout = new Promise<never>((_resolve, reject) => {
			const handle = setTimeout(() => reject(new Error('Site write lock heartbeat timed out')), timeoutMs)
			;(handle as unknown as { unref?: () => void }).unref?.()
		})
		// A probe that loses the race must not surface as unhandled later.
		void timeout.catch(() => undefined)
		void Promise.race([runCancellableLockQuery(() => conn`SELECT 1`), timeout]).then(
			() => {
				probing = false
			},
			(error) => {
				stopped = true
				if (timer) clearInterval(timer)
				onLost(error)
			},
		)
	}
	timer = setInterval(tick, intervalMs)
	;(timer as unknown as { unref?: () => void }).unref?.()
	return {
		stop: () => {
			stopped = true
			if (timer) clearInterval(timer)
			timer = null
		},
	}
}

/**
 * Run `fn` on an already-reserved connection while holding the per-site lock.
 * `fn` receives a signal that aborts when the caller aborts or when the lock
 * session is lost, so long downloads can stop instead of writing without
 * mutual exclusion. The connection is released after normal
 * acquisition/callback paths. An unlock failure or a detected session loss
 * closes its physical session so a potentially lock-owning backend cannot be
 * reused or permanently consume a pool slot.
 */
export async function withReservedSiteWriteLock<T>(
	conn: SiteWriteLockConnection,
	did: string,
	rkey: string,
	fn: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
	heartbeat: LockHeartbeatOptions = {},
): Promise<T> {
	const lockId = siteWriteLockId(did, rkey)
	let held = false
	let lockLost = false
	let connectionSafeToRelease = true
	const lockLoss = new AbortController()
	const safetySignal = signal ? AbortSignal.any([signal, lockLoss.signal]) : lockLoss.signal
	try {
		try {
			await runCancellableLockQuery(() => conn`SET lock_timeout = '45s'`, signal)
			await runCancellableLockQuery(() => conn`SELECT pg_advisory_lock(${lockId}::bigint)`, signal)
			held = true
		} catch (error) {
			if (signal?.aborted) {
				// Cancellation can race a server-side lock grant. Never return this
				// session to the pool unless it has been physically closed.
				connectionSafeToRelease = false
				try {
					await conn.close({ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS })
				} catch (closeError) {
					logger.error('[DB] Failed to close aborted site-write lock connection', undefined, {
						did,
						rkey,
						errorKind: databaseErrorKind(closeError),
					})
				}
			}
			logger.error('[DB] Failed to acquire site-write lock', undefined, {
				did,
				rkey,
				errorKind: databaseErrorKind(error),
			})
			throw new SiteWriteLockAcquisitionError(error)
		}

		const monitor = startLockHeartbeat(conn, heartbeat, (error) => {
			lockLost = true
			lockLoss.abort(error instanceof Error ? error : new Error('Site write lock session was lost'))
		})
		try {
			if (signal?.aborted) throw abortReason(signal)
			const callback = Promise.resolve(fn(safetySignal))
			// The callback can outlive the lock; observe its eventual failure
			// without letting it surface as an unhandled rejection.
			void callback.catch((callbackError) => {
				if (lockLost) {
					logger.warn('[DB] Lock callback failed after lock session loss', {
						did,
						rkey,
						errorKind: databaseErrorKind(callbackError),
					})
				}
			})
			const lost = new Promise<never>((_resolve, reject) => {
				lockLoss.signal.addEventListener('abort', () => reject(new SiteWriteLockLostError(lockLoss.signal.reason)), {
					once: true,
				})
			})
			// Fail fast on lock loss: waiting for a callback that no longer runs
			// under mutual exclusion would hide a fencing breach.
			return await Promise.race([callback, lost])
		} finally {
			monitor.stop()
			if (held) {
				if (lockLost) {
					// The session — and with it the server-side advisory lock — is
					// gone. Skip the pointless unlock query and retire the session.
					connectionSafeToRelease = false
					try {
						await conn.close({ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS })
					} catch (closeError) {
						logger.error('[DB] Failed to close lost site-write lock connection', undefined, {
							did,
							rkey,
							errorKind: databaseErrorKind(closeError),
						})
					}
				} else {
					let unlockFailure: unknown
					try {
						const result = await conn`SELECT pg_advisory_unlock(${lockId}::bigint) AS unlocked`
						if (!advisoryUnlockReturnedTrue(result)) unlockFailure = new Error('Advisory lock was not released')
					} catch (error) {
						unlockFailure = error
					}

					if (unlockFailure) {
						// Advisory locks are session-scoped. A thrown unlock or a false
						// result means this session must never return to the reusable pool.
						connectionSafeToRelease = false
						logger.error('[DB] Failed to release site write lock; quarantining connection', undefined, {
							did,
							rkey,
							errorKind: databaseErrorKind(unlockFailure),
						})
						try {
							await conn.close({ timeout: LOCK_POOL_RETIRE_TIMEOUT_SECONDS })
						} catch (closeError) {
							// Cleanup must not replace a callback failure or expose driver details.
							logger.error('[DB] Failed to close quarantined site-write lock connection', undefined, {
								did,
								rkey,
								errorKind: databaseErrorKind(closeError),
							})
						}
					}
				}
			}
		}
	} finally {
		if (connectionSafeToRelease) {
			try {
				conn.release()
			} catch (error) {
				// Keep the callback/acquisition outcome intact if client cleanup fails.
				logger.error('[DB] Failed to release site-write lock connection', undefined, {
					did,
					rkey,
					errorKind: databaseErrorKind(error),
				})
			}
		}
	}
}

/**
 * Run `fn` while holding the per-site write lock, serializing all cache writers
 * for `${did}/${rkey}` across drivers and instances.
 *
 * Uses a blocking acquire bounded by lock_timeout so a stuck holder cannot wedge
 * the queue forever. An acquisition timeout or database error fails closed: the
 * caller receives an error and can retry without writing concurrently.
 *
 * While `fn` runs, the lock session is kept alive with periodic liveness
 * probes (proxies idle-kill idle sessions at 60s) and `fn` receives a signal
 * that aborts on caller abort or on lock-session loss, so a lost advisory lock
 * stops the protected work instead of silently writing without exclusion.
 */
export async function withSiteWriteLock<T>(
	did: string,
	rkey: string,
	fn: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
	heartbeat: LockHeartbeatOptions = {},
): Promise<T> {
	let conn: SiteWriteLockConnection

	try {
		conn = await lockPool.reserve(signal)
	} catch (error) {
		logger.error('[DB] Failed to reserve site-write lock connection', undefined, {
			did,
			rkey,
			errorKind: databaseErrorKind(error),
		})
		throw new SiteWriteLockAcquisitionError(error)
	}

	return await withReservedSiteWriteLock(conn, did, rkey, fn, signal, heartbeat)
}

// Read functions

export async function getSiteCache(did: string, rkey: string): Promise<SiteCache | null> {
	const result = await sql<SiteCache[]>`
    SELECT did, rkey, record_cid, file_cids, cached_at, updated_at, cold_synced
    FROM site_cache
    WHERE did = ${did} AND rkey = ${rkey}
    LIMIT 1
  `
	return result[0] || null
}

export async function getSiteSettingsCache(did: string, rkey: string): Promise<SiteSettingsCache | null> {
	const result = await sql<SiteSettingsCache[]>`
    SELECT did, rkey, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at
    FROM site_settings_cache
    WHERE did = ${did} AND rkey = ${rkey}
    LIMIT 1
  `
	return result[0] || null
}

/**
 * List all known DIDs from all DID-bearing tables.
 * Missing tables are skipped to keep bootstrapping resilient.
 */
export async function listAllKnownDids(): Promise<string[]> {
	const sources: Array<{ name: string; fetch: () => Promise<Array<{ did: string }>> }> = [
		{
			name: 'site_cache',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM site_cache
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
		{
			name: 'site_settings_cache',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM site_settings_cache
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
		{
			name: 'domains',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM domains
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
		{
			name: 'custom_domains',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM custom_domains
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
		{
			name: 'supporter',
			fetch: () => sql<Array<{ did: string }>>`
        SELECT DISTINCT did
        FROM supporter
        WHERE did IS NOT NULL AND did <> ''
      `,
		},
	]
	const dids = new Set<string>()

	for (const source of sources) {
		try {
			const rows = await source.fetch()
			for (const row of rows) {
				if (typeof row.did === 'string' && row.did.length > 0) {
					dids.add(row.did)
				}
			}
		} catch {
			logger.warn(`[DB] Skipping DID source table ${source.name}`)
		}
	}

	return [...dids].sort()
}

// Write functions

export async function upsertSiteCache(
	did: string,
	rkey: string,
	recordCid: string,
	fileCids: Record<string, string>,
	// The firehose owns the S3 cold tier, so it always marks the row synced once
	// it has finished writing files. Defaults to true to keep existing call sites
	// (and the contract that this function is only called after S3 writes) intact.
	coldSynced = true,
): Promise<void> {
	logger.debug(`[DB] upsertSiteCache starting for ${did}/${rkey}`)
	try {
		await sql`
      INSERT INTO site_cache (did, rkey, record_cid, file_cids, cached_at, updated_at, cold_synced)
      VALUES (${did}, ${rkey}, ${recordCid}, ${sql.json(fileCids ?? {})}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()), ${coldSynced})
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        record_cid = EXCLUDED.record_cid,
        file_cids = EXCLUDED.file_cids,
        updated_at = EXTRACT(EPOCH FROM NOW()),
        cold_synced = EXCLUDED.cold_synced
    `
		logger.debug(`[DB] upsertSiteCache completed for ${did}/${rkey}`)
	} catch (err) {
		logger.error('[DB] upsertSiteCache error', err, { did, rkey })
		throw err
	}
}

/** Keep an empty durable manifest so hosting can distinguish a confirmed delete from a projection/storage outage. */
export async function markSiteCacheDeleted(did: string, rkey: string): Promise<void> {
	await upsertSiteCache(did, rkey, DELETED_SITE_RECORD_CID, {})
}

export async function upsertSiteSettingsCache(
	did: string,
	rkey: string,
	recordCid: string,
	settings: {
		directoryListing: boolean
		spaMode?: string
		custom404?: string
		indexFiles?: string[]
		cleanUrls: boolean
		headers?: Array<{ name: string; value: string; path?: string }>
	},
): Promise<void> {
	const directoryListing = settings.directoryListing ?? false
	const spaMode = settings.spaMode ?? null
	const custom404 = settings.custom404 ?? null
	const cleanUrls = settings.cleanUrls ?? true

	const indexFiles = settings.indexFiles ?? []
	const headers = settings.headers ?? []

	logger.debug(`[DB] upsertSiteSettingsCache starting for ${did}/${rkey}`, {
		directoryListing,
		spaMode,
		custom404,
		indexFiles,
		cleanUrls,
		headers,
	})

	try {
		await sql`
      INSERT INTO site_settings_cache (did, rkey, record_cid, directory_listing, spa_mode, custom_404, index_files, clean_urls, headers, cached_at, updated_at)
      VALUES (
        ${did},
        ${rkey},
        ${recordCid},
        ${directoryListing},
        ${spaMode},
        ${custom404},
        ${sql.json(indexFiles)},
        ${cleanUrls},
        ${sql.json(headers)},
        EXTRACT(EPOCH FROM NOW()),
        EXTRACT(EPOCH FROM NOW())
      )
      ON CONFLICT (did, rkey)
      DO UPDATE SET
        record_cid = EXCLUDED.record_cid,
        directory_listing = EXCLUDED.directory_listing,
        spa_mode = EXCLUDED.spa_mode,
        custom_404 = EXCLUDED.custom_404,
        index_files = EXCLUDED.index_files,
        clean_urls = EXCLUDED.clean_urls,
        headers = EXCLUDED.headers,
        updated_at = EXTRACT(EPOCH FROM NOW())
    `
		logger.debug(`[DB] upsertSiteSettingsCache completed for ${did}/${rkey}`)
	} catch (err) {
		logger.error('[DB] upsertSiteSettingsCache error', err, { did, rkey })
		throw err
	}
}

export async function deleteSiteSettingsCache(did: string, rkey: string): Promise<void> {
	await sql`DELETE FROM site_settings_cache WHERE did = ${did} AND rkey = ${rkey}`
}

export async function isSupporter(did: string): Promise<boolean> {
	const rows = await sql`SELECT 1 FROM supporter WHERE did = ${did} LIMIT 1`
	return rows.length > 0
}

export async function closeDatabase(): Promise<void> {
	await Promise.all([sql.end({ timeout: 5 }), lockPool.end({ timeout: 5 })])
	logger.info('[DB] Database connections closed')
}

export { sql }
