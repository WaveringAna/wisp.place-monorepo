export const REPLAY_READY_MAX_AGE_MS = 5 * 60_000
/** Relay clocks may run slightly ahead of ours; anything beyond this is not trusted. */
export const SOURCE_CLOCK_SKEW_MS = 60_000

export type RelayLabel = 'primary' | 'secondary' | 'configured'

export interface SourceProgress {
	relay: RelayLabel
	/** Epoch ms of the last trusted relay event timestamp (evt.time). */
	sourceEventTimeMs?: number
	/** Last accepted relay sequence. */
	sequence?: number
	/** The most recent event carried an unparseable or future timestamp. */
	invalidTimestamp: boolean
	/** Events with such a timestamp since the last reset. */
	invalidTimestamps: number
	/** An event has been observed since the last reset; used to report replay lag once. */
	observed: boolean
}

export type ReplayStatus = 'unknown' | 'invalid' | 'caught-up' | 'catching-up'

export interface ReplayAge {
	status: ReplayStatus
	replayAgeMs?: number
	/** Never true until a trusted timestamp has been seen. */
	ready: boolean
}

/** Fresh progress for an initial start or a relay switch: no prior age may carry over. */
export function resetSourceProgress(relay: RelayLabel): SourceProgress {
	return { relay, invalidTimestamp: false, invalidTimestamps: 0, observed: false }
}

/** Epoch ms for a relay timestamp, or undefined if unparseable or beyond the allowed skew. */
export function parseSourceTime(time: unknown, now: number): number | undefined {
	if (typeof time !== 'string' || time === '') return undefined
	const ms = Date.parse(time)
	if (!Number.isFinite(ms) || ms > now + SOURCE_CLOCK_SKEW_MS) return undefined
	return ms
}

/**
 * Record an accepted event. Relays forward the time each PDS stamped on its event, so one PDS can
 * stamp events in the past (re-emitting old ones) or in the future (a wrong clock). Progress is the
 * newest trusted time: an old stamp cannot pull it back, and an unusable one leaves it as it was,
 * where it keeps ageing until a trusted event arrives.
 */
export function observeSourceEvent(
	progress: SourceProgress,
	event: { seq: number; time?: unknown },
	now: number,
): SourceProgress {
	const eventTimeMs = parseSourceTime(event.time, now)
	if (eventTimeMs === undefined) {
		return {
			...progress,
			sequence: event.seq,
			invalidTimestamp: true,
			invalidTimestamps: progress.invalidTimestamps + 1,
			observed: true,
		}
	}
	const sourceEventTimeMs = Math.max(progress.sourceEventTimeMs ?? eventTimeMs, eventTimeMs)
	return { ...progress, sourceEventTimeMs, sequence: event.seq, invalidTimestamp: false, observed: true }
}

export function evaluateReplayAge(
	progress: SourceProgress,
	now: number,
	maxAgeMs = REPLAY_READY_MAX_AGE_MS,
): ReplayAge {
	if (progress.sourceEventTimeMs === undefined) {
		return { status: progress.invalidTimestamp ? 'invalid' : 'unknown', ready: false }
	}
	const replayAgeMs = Math.max(0, now - progress.sourceEventTimeMs)
	const ready = replayAgeMs <= maxAgeMs
	return { status: ready ? 'caught-up' : 'catching-up', replayAgeMs, ready }
}

export interface StaleReplayReport {
	relay: RelayLabel
	sourceTime: string
	replayAgeMs: number
}

/**
 * Report only the first accepted event after a start or relay switch, and only
 * when it shows the relay replaying data older than the readiness threshold.
 * Durable cursors are numeric, so this is the first point their age is known.
 * Purely informational: callers must not refuse or move a cursor on it.
 */
export function staleReplayReport(
	before: SourceProgress,
	after: SourceProgress,
	now: number,
	maxAgeMs = REPLAY_READY_MAX_AGE_MS,
): StaleReplayReport | undefined {
	if (before.observed) return undefined
	const age = evaluateReplayAge(after, now, maxAgeMs)
	if (age.status !== 'catching-up' || age.replayAgeMs === undefined || after.sourceEventTimeMs === undefined) {
		return undefined
	}
	return {
		relay: after.relay,
		sourceTime: new Date(after.sourceEventTimeMs).toISOString(),
		replayAgeMs: age.replayAgeMs,
	}
}
