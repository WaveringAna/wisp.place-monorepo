/**
 * Time-based cursor estimation across relays.
 *
 * Relays number events in independent sequence spaces, so a cursor from one
 * relay means nothing to another, and a target relay's own stored checkpoint
 * may be arbitrarily old (it is whatever was saved when that relay was last
 * active). On failover we instead find the target relay's sequence for a time
 * slightly before the source relay's safe cursor. Replays of already-processed
 * events are harmless: site work re-reads the authoritative record under the
 * site lock and cache writes are CID-based.
 */

/** How far behind the source relay's safe-cursor time the target starts. */
export const FAILOVER_REWIND_MS = 5 * 60_000

export interface ProbedPosition {
	seq: number
	timeMs: number
}

/** First event after `cursor` (live head when undefined). */
export type RelayProbe = (cursor: number | undefined) => Promise<ProbedPosition>

export interface RelaySeekOptions {
	/** Stop once a cursor at most this far behind the target time is found. */
	toleranceMs?: number
	/** Hard cap on relay round-trips. */
	maxProbes?: number
	/** Minimum assumed relay rate, used only to size the first backward step. */
	minEventsPerSecond?: number
}

export interface RelaySeekResult {
	/** Resume cursor: the relay delivers events after this sequence. */
	cursor: number
	/** Time of the first event delivered after `cursor`. */
	timeMs: number
	probes: number
	/** The relay no longer retains the target time; `cursor` is its oldest event. */
	beyondRetention: boolean
}

/**
 * Find a cursor whose next event is at or before `targetTimeMs`, as close to it
 * as `toleranceMs` allows. Every returned cursor is at or behind the target, so
 * a caller can only replay, never skip. Relay timestamps are not strictly
 * monotonic; the caller's rewind margin absorbs small inversions.
 */
export async function seekRelayCursorByTime(
	probe: RelayProbe,
	targetTimeMs: number,
	options: RelaySeekOptions = {},
): Promise<RelaySeekResult> {
	const toleranceMs = options.toleranceMs ?? 60_000
	const maxProbes = options.maxProbes ?? 48
	const minRate = options.minEventsPerSecond ?? 100
	let probes = 0
	const at = async (cursor: number | undefined) => {
		if (probes >= maxProbes) throw new Error('Relay seek exceeded its probe budget')
		probes++
		return probe(cursor)
	}

	const head = await at(undefined)
	if (head.timeMs <= targetTimeMs) {
		return { cursor: Math.max(0, head.seq - 1), timeMs: head.timeMs, probes, beyondRetention: false }
	}

	// Exponential search backwards for a cursor at or before the target time.
	let hi = head.seq
	let lo: ProbedPosition & { cursor: number }
	let step = Math.max(1_000, Math.ceil(((head.timeMs - targetTimeMs) / 1000) * minRate))
	for (;;) {
		const cursor = Math.max(0, hi - step)
		const position = await at(cursor)
		// A cursor older than retention is answered from the relay's oldest event.
		const jumped = position.seq - cursor > step
		if (position.timeMs <= targetTimeMs) {
			lo = { cursor, ...position }
			break
		}
		if (jumped || cursor === 0) {
			return { cursor, timeMs: position.timeMs, probes, beyondRetention: true }
		}
		hi = cursor
		step *= 2
	}

	// Bisect between a cursor at/behind the target and one past it.
	while (hi - lo.cursor > 1 && targetTimeMs - lo.timeMs > toleranceMs && probes < maxProbes) {
		const mid = lo.cursor + Math.floor((hi - lo.cursor) / 2)
		const position = await at(mid)
		if (position.timeMs <= targetTimeMs) lo = { cursor: mid, ...position }
		else hi = mid
	}
	return { cursor: lo.cursor, timeMs: lo.timeMs, probes, beyondRetention: false }
}
