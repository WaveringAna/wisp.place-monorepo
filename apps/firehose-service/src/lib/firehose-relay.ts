/**
 * Relay lifecycle primitives. They have no runtime singleton ownership.
 */

/** Default durable-recovery replay backoff settings. */
export const DEFAULT_DURABLE_REPLAY_BASE_DELAY_MS = 1_000
export const DEFAULT_DURABLE_REPLAY_MAX_DELAY_MS = 30_000
export const DEFAULT_DURABLE_REPLAY_MAX_FAILURES = 3
/**
 * A replay failure is only meaningfully consecutive for this long. This is
 * deliberately longer than the normal replay backoff, but finite so a relay
 * outage separated by healthy time cannot permanently exhaust the budget.
 */
export const DEFAULT_DURABLE_REPLAY_FAILURE_DECAY_MS = 60_000

export interface DurableReplayBackoffOptions {
	baseDelayMs?: number
	maxDelayMs?: number
	maxConsecutiveFailures?: number
	/** Elapsed healthy time clears the stale failure burst. */
	failureDecayMs?: number
	/** Wall-clock seam for deterministic decay tests. */
	now?: () => number
	random?: () => number
}

export interface DurableReplayFailureAttempt {
	consecutiveFailures: number
	delayCapMs: number
	delayMs: number
	terminal: boolean
}

/** Return the bounded exponential cap for a one-based failure attempt. */
export function durableReplayBackoffCap(
	attempt: number,
	baseDelayMs = DEFAULT_DURABLE_REPLAY_BASE_DELAY_MS,
	maxDelayMs = DEFAULT_DURABLE_REPLAY_MAX_DELAY_MS,
): number {
	const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1
	const safeBase = Number.isSafeInteger(baseDelayMs) && baseDelayMs >= 0 ? baseDelayMs : 0
	const safeMax = Number.isSafeInteger(maxDelayMs) && maxDelayMs >= 0 ? maxDelayMs : safeBase
	return Math.min(safeMax, safeBase * 2 ** (safeAttempt - 1))
}

/** Pick a delay uniformly from the complete [0, cap] range. */
export function durableReplayFullJitter(capMs: number, random: () => number = Math.random): number {
	if (!Number.isSafeInteger(capMs) || capMs <= 0) return 0
	const sample = random()
	const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0
	return Math.min(capMs, Math.floor(normalized * (capMs + 1)))
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * Tracks failures to durably hand work to the revalidation queue. A healthy
 * interval clears the stale failure burst; this keeps "consecutive" meaningful
 * across long outages without allowing a stale budget to remain terminal
 * forever. It is deliberately independent from ordinary relay event health:
 * receiving an event does not prove that durable recovery capacity returned.
 */
export class DurableReplayBackoff {
	private consecutive = 0
	private lastFailureAt: number | undefined
	private readonly baseDelayMs: number
	private readonly maxDelayMs: number
	private readonly maxConsecutiveFailures: number
	private readonly failureDecayMs: number
	private readonly now: () => number
	private readonly random: () => number

	constructor(options: DurableReplayBackoffOptions = {}) {
		this.baseDelayMs = nonNegativeInteger(options.baseDelayMs, DEFAULT_DURABLE_REPLAY_BASE_DELAY_MS)
		this.maxDelayMs = nonNegativeInteger(options.maxDelayMs, DEFAULT_DURABLE_REPLAY_MAX_DELAY_MS)
		this.maxConsecutiveFailures = positiveInteger(options.maxConsecutiveFailures, DEFAULT_DURABLE_REPLAY_MAX_FAILURES)
		this.failureDecayMs = positiveInteger(options.failureDecayMs, DEFAULT_DURABLE_REPLAY_FAILURE_DECAY_MS)
		this.now = options.now ?? Date.now
		this.random = options.random ?? Math.random
	}

	get consecutiveFailures(): number {
		this.decay(this.readNow())
		return this.consecutive
	}

	/** Whether a terminal controller may try again after elapsed healthy time. */
	canRetryAfterDecay(): boolean {
		this.decay(this.readNow())
		return this.consecutive < this.maxConsecutiveFailures
	}

	recordFailure(): DurableReplayFailureAttempt {
		const now = this.readNow()
		this.decay(now)
		if (this.consecutive >= this.maxConsecutiveFailures) {
			// A failure which occurs while terminal is still a failure. Move the
			// decay origin so repeated rapid attempts cannot evade the cooldown.
			this.lastFailureAt = now
			return {
				consecutiveFailures: this.consecutive,
				delayCapMs: durableReplayBackoffCap(this.consecutive, this.baseDelayMs, this.maxDelayMs),
				delayMs: 0,
				terminal: true,
			}
		}

		this.consecutive++
		this.lastFailureAt = now
		const delayCapMs = durableReplayBackoffCap(this.consecutive, this.baseDelayMs, this.maxDelayMs)
		return {
			consecutiveFailures: this.consecutive,
			delayCapMs,
			delayMs: durableReplayFullJitter(delayCapMs, this.random),
			terminal: this.consecutive >= this.maxConsecutiveFailures,
		}
	}

	/** Only durable enqueue success may clear this failure budget. */
	recordSuccess(): void {
		this.consecutive = 0
		this.lastFailureAt = undefined
	}

	reset(): void {
		this.consecutive = 0
		this.lastFailureAt = undefined
	}

	private readNow(): number {
		try {
			const value = this.now()
			return Number.isFinite(value) ? value : Date.now()
		} catch {
			return Date.now()
		}
	}

	private decay(now: number): void {
		if (this.consecutive === 0 || this.lastFailureAt === undefined || now <= this.lastFailureAt) return
		const elapsedIntervals = Math.floor((now - this.lastFailureAt) / this.failureDecayMs)
		if (elapsedIntervals < 1) return
		// Treat one full interval without another failure as healthy recovery. A
		// terminal controller can therefore make one fresh probe instead of
		// immediately re-exhausting the budget on its next request.
		this.consecutive = 0
		this.lastFailureAt = undefined
	}
}

type ReplayTimer = ReturnType<typeof setTimeout>

export interface DurableReplayControllerOptions {
	backoff?: DurableReplayBackoff
	setTimeout?: (callback: () => void, delayMs: number) => ReplayTimer
	clearTimeout?: (timer: ReplayTimer) => void
}

/**
 * Serializes delayed replay reconnects and makes a pending backoff cancellable.
 * The generation check prevents a timer released during shutdown from opening
 * a new relay after intake has stopped.
 */
export class DurableReplayController {
	private readonly backoff: DurableReplayBackoff
	private readonly scheduleTimer: (callback: () => void, delayMs: number) => ReplayTimer
	private readonly cancelTimer: (timer: ReplayTimer) => void
	private pendingReconnect: Promise<void> | null = null
	private cancelPendingWait: (() => void) | null = null
	private generation = 0
	private stopped = false
	private terminal = false

	constructor(options: DurableReplayControllerOptions = {}) {
		this.backoff = options.backoff ?? new DurableReplayBackoff()
		this.scheduleTimer = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs))
		this.cancelTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer))
	}

	get pending(): Promise<void> | null {
		return this.pendingReconnect
	}

	get consecutiveFailures(): number {
		return this.backoff.consecutiveFailures
	}

	request(
		reconnect: () => Promise<void>,
		onTerminal: (attempt: DurableReplayFailureAttempt) => void,
	): DurableReplayFailureAttempt | undefined {
		if (this.stopped || this.pendingReconnect) return undefined
		// A terminal callback may deliberately leave the worker alive while durable
		// capacity drains. Permit a later request once the time-decayed budget is
		// below the terminal threshold; without this gate terminal would be a
		// permanent process state until the whole lifecycle restarted.
		if (this.terminal) {
			if (!this.backoff.canRetryAfterDecay()) return undefined
			this.terminal = false
		}

		const attempt = this.backoff.recordFailure()
		if (attempt.terminal) {
			this.terminal = true
			onTerminal(attempt)
			return attempt
		}

		const generation = this.generation
		const pending = (async () => {
			if (!(await this.waitForBackoff(attempt.delayMs, generation))) return
			if (this.stopped || generation !== this.generation) return
			await reconnect()
		})()
		this.pendingReconnect = pending
		void pending.then(
			() => this.clearPending(pending),
			() => this.clearPending(pending),
		)
		return attempt
	}

	/** Called only after enqueueSiteRevalidation reports durable success. */
	recordDurableSuccess(): void {
		this.backoff.recordSuccess()
		this.terminal = false
	}

	/** Cancel a pending delay and prevent any future reconnects. */
	stop(): void {
		this.stopped = true
		this.generation++
		this.cancelPendingWait?.()
		this.cancelPendingWait = null
	}

	/** Start a fresh lifecycle and clear the prior durable-recovery budget. */
	reset(): void {
		this.stopped = true
		this.generation++
		this.cancelPendingWait?.()
		this.cancelPendingWait = null
		this.backoff.reset()
		this.terminal = false
		this.stopped = false
	}

	private clearPending(pending: Promise<void>): void {
		if (this.pendingReconnect === pending) this.pendingReconnect = null
	}

	private waitForBackoff(delayMs: number, generation: number): Promise<boolean> {
		if (delayMs <= 0) return Promise.resolve(!this.stopped && generation === this.generation)

		return new Promise((resolve) => {
			let settled = false
			let timer: ReplayTimer | undefined
			const cancel = () => finish(false)
			const finish = (ready: boolean) => {
				if (settled) return
				settled = true
				if (timer !== undefined) this.cancelTimer(timer)
				if (this.cancelPendingWait === cancel) this.cancelPendingWait = null
				resolve(ready && !this.stopped && generation === this.generation)
			}

			this.cancelPendingWait = cancel
			timer = this.scheduleTimer(() => finish(true), delayMs)
		})
	}
}

/**
 * Tracks relay failures separately from socket connection state. A connection
 * alone never resets the cross-relay budget; only a received event does.
 */
export class RelayFailureBudget {
	private consecutive = 0
	private swaps = 0
	private stalls = 0

	get consecutiveFailures(): number {
		return this.consecutive
	}

	get swapsWithoutSuccess(): number {
		return this.swaps
	}

	recordConnected(): void {
		// Intentionally empty. A TCP/WebSocket handshake is not a usable relay.
	}

	recordEvent(): void {
		this.consecutive = 0
		this.swaps = 0
		this.stalls = 0
	}

	recordConnectionError(): number {
		this.consecutive++
		return this.consecutive
	}

	canFailOver(): boolean {
		return this.swaps < 2
	}

	recordFailOver(): void {
		this.consecutive = 0
		this.swaps++
		this.stalls = 0
	}

	recordStall(): number {
		this.stalls++
		return this.stalls
	}

	reset(): void {
		this.consecutive = 0
		this.swaps = 0
		this.stalls = 0
	}
}

/** Invalidates callbacks from a relay as soon as it is being replaced. */
export class RelayGenerationGuard {
	private generation = 0

	beginConnection(): number {
		this.generation++
		return this.generation
	}

	invalidate(): void {
		this.generation++
	}

	isCurrent(generation: number): boolean {
		return generation === this.generation
	}
}

/** Await source destruction before opening a replacement relay. */
export async function destroyThenConnect(
	destroy: () => Promise<void>,
	shouldConnect: () => boolean,
	connect: () => void,
): Promise<void> {
	await destroy()
	if (shouldConnect()) connect()
}

/** Durable relay checkpoint lookup. `unavailable` is distinct from `missing`. */
export type RelayCursorLoad = { kind: 'found'; cursor: number } | { kind: 'missing' } | { kind: 'unavailable' }

export interface RelayCursorStore {
	read(service: string): Promise<RelayCursorLoad>
	save(service: string, cursor: number): Promise<boolean>
}

export interface RelayCursorActivation {
	/** A safe cursor, or undefined to start live after a confirmed missing checkpoint. */
	cursor: number | undefined
	/** True only when durable storage proved that this relay has no usable checkpoint. */
	missingCheckpoint: boolean
}

/**
 * Keeps relay checkpoint state separate by normalized relay identity. Before a
 * cross-relay switch it persists the old relay's completed prefix, then loads
 * the target relay's durable prefix. A durable-store error is a hard stop: the
 * caller must not subscribe from an unknown position.
 */
export class RelayCursorCoordinator {
	private readonly cursorsByRelay = new Map<string, number | undefined>()
	private active: { service: string; identity: string } | null = null

	constructor(private readonly relayIdentity: (service: string) => string) {}

	initialize(service: string, cursor: number | undefined): number | undefined {
		const safeCursor = this.toCursor(cursor)
		const identity = this.relayIdentity(service)
		this.active = { service, identity }
		this.cursorsByRelay.set(identity, safeCursor)
		return safeCursor
	}

	recordActiveCursor(cursor: number | undefined): void {
		if (!this.active) return
		this.cursorsByRelay.set(this.active.identity, this.toCursor(cursor))
	}

	knownCursor(service: string): number | undefined {
		return this.cursorsByRelay.get(this.relayIdentity(service))
	}

	async switchTo(
		targetService: string,
		currentCursor: number | undefined,
		store: RelayCursorStore,
	): Promise<RelayCursorActivation | undefined> {
		const targetIdentity = this.relayIdentity(targetService)
		if (this.active?.identity === targetIdentity) {
			const cursor = this.toCursor(currentCursor)
			this.recordActiveCursor(cursor)
			return { cursor, missingCheckpoint: false }
		}

		if (this.active) {
			const sourceCursor = this.toCursor(currentCursor)
			// A live relay has no confirmed prefix to persist. Writing zero here
			// would turn a confirmed missing/corrupt checkpoint into a misleading
			// replay position on the next failover.
			if (sourceCursor !== undefined) {
				if (!(await store.save(this.active.service, sourceCursor))) return undefined
				this.cursorsByRelay.set(this.active.identity, sourceCursor)
			} else {
				this.cursorsByRelay.set(this.active.identity, undefined)
			}
		}

		const loaded = await store.read(targetService)
		if (loaded.kind === 'unavailable') return undefined
		const cursor = loaded.kind === 'found' ? this.toCursor(loaded.cursor) : undefined
		this.active = { service: targetService, identity: targetIdentity }
		this.cursorsByRelay.set(targetIdentity, cursor)
		return { cursor, missingCheckpoint: loaded.kind === 'missing' }
	}

	private toCursor(cursor: number | undefined): number | undefined {
		return typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined
	}
}
