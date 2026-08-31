/**
 * Ordered relay cursor accounting primitives.
 * Kept independent from the runtime singleton so they are deterministic and testable.
 */

/** A cursor reservation that is completed only after its site work is safe. */
export interface CursorReservation {
	readonly seq: number
	complete(): void
	fail(): void
}

interface PendingCursorGroup {
	seq: number
	remaining: number
	failed: boolean
	sealed: boolean
	generation: number
}

interface CursorWaiter {
	seq: number
	resolve: (reservation: CursorReservation | undefined) => void
}

export function isValidFirehoseSeq(seq: unknown): seq is number {
	return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0
}

/**
 * Tracks received firehose sequences in arrival order.
 *
 * A relay sequence can contain several commit operations. They share one
 * bounded queue slot and count down together, so a small queue cannot deadlock
 * while a single commit contains several operations. A group is sealed by the
 * next sequence or source shutdown before it becomes checkpointable.
 */
export class OrderedCursorTracker {
	private readonly pending: PendingCursorGroup[] = []
	private readonly waiters: CursorWaiter[] = []
	private accepting = true
	private generation = 0
	private confirmedCursor: number | undefined
	private openGroup: PendingCursorGroup | null = null

	constructor(
		private readonly maxPendingEvents: number,
		initialCursor?: number,
	) {
		if (!Number.isSafeInteger(maxPendingEvents) || maxPendingEvents < 1) {
			throw new Error('maxPendingEvents must be a positive safe integer')
		}
		this.confirmedCursor = isValidFirehoseSeq(initialCursor) ? initialCursor : undefined
	}

	/** The newest fully completed and sealed relay sequence. */
	get cursor(): number | undefined {
		return this.confirmedCursor
	}

	/**
	 * The cursor safe to persist or use for reconnecting. If the first received
	 * event has not completed yet, use the sequence immediately before it so it
	 * is replayed rather than lost.
	 */
	get resumableCursor(): number | undefined {
		if (this.confirmedCursor !== undefined) return this.confirmedCursor
		const first = this.pending[0]?.seq
		return first !== undefined && first > 0 ? first - 1 : undefined
	}

	/** Number of bounded relay-sequence groups awaiting a checkpoint. */
	get pendingCount(): number {
		return this.pending.length
	}

	get isAccepting(): boolean {
		return this.accepting
	}

	/**
	 * Reserve capacity before accepting an event. Callers await this when the
	 * bounded queue is full, which lets Firehose apply natural backpressure.
	 * Invalid, duplicate, and rewound sequences are ignored and never regress a
	 * confirmed cursor.
	 */
	reserve(seq: number): Promise<CursorReservation | undefined> {
		if (!this.accepting || !isValidFirehoseSeq(seq) || this.isStaleOrRewound(seq)) {
			return Promise.resolve(undefined)
		}

		const reservation = this.admit(seq)
		if (reservation !== null) return Promise.resolve(reservation)
		return new Promise((resolve) => {
			this.waiters.push({ seq, resolve })
		})
	}

	/** Stop admitting waiting events and make them return without scheduling work. */
	stopAccepting(): void {
		this.accepting = false
		for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined)
	}

	/** Seal the trailing relay sequence after the source has been destroyed. */
	sealOpenSequence(): void {
		if (this.openGroup) this.openGroup.sealed = true
		this.openGroup = null
		this.advanceCursor()
	}

	/** Reset stale pending work before reconnecting from a known safe cursor. */
	reset(initialCursor?: number): void {
		this.generation++
		this.pending.length = 0
		this.openGroup = null
		this.confirmedCursor = isValidFirehoseSeq(initialCursor) ? initialCursor : undefined
		this.accepting = true
		for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined)
	}

	private isStaleOrRewound(seq: number): boolean {
		if (this.confirmedCursor !== undefined && seq <= this.confirmedCursor) return true
		const newest = this.pending[this.pending.length - 1]
		if (newest && seq < newest.seq) return true
		// A sequence which was already sealed cannot be extended later without
		// risking a checkpoint regression. Relay delivery is ordered, so it is a
		// duplicate/replay and can be safely ignored.
		if (newest && newest.seq === seq && this.openGroup !== newest) return true
		return false
	}

	/**
	 * Returns null only when a new sequence must wait for bounded capacity.
	 * Callers must validate staleness before this method.
	 */
	private admit(seq: number, releaseWaiters = true): CursorReservation | undefined | null {
		if (this.openGroup && this.openGroup.seq === seq) {
			return this.createReservation(this.openGroup)
		}

		// Seal and advance before evaluating capacity. This is essential at a
		// capacity of one: an already-completed trailing sequence must make room
		// for the next sequence rather than waiting forever to be sealed.
		if (this.openGroup) {
			this.openGroup.sealed = true
			this.openGroup = null
			this.advanceCursor(false)
		}

		if (this.pending.length >= this.maxPendingEvents) return null
		const group: PendingCursorGroup = {
			seq,
			remaining: 0,
			failed: false,
			sealed: false,
			generation: this.generation,
		}
		this.pending.push(group)
		this.openGroup = group
		const reservation = this.createReservation(group)
		if (releaseWaiters) this.releaseWaiters()
		return reservation
	}

	private createReservation(group: PendingCursorGroup): CursorReservation {
		group.remaining++
		return {
			seq: group.seq,
			complete: () => {
				if (group.generation !== this.generation || group.failed || group.remaining < 1) return
				group.remaining--
				this.advanceCursor()
			},
			fail: () => {
				if (group.generation !== this.generation || group.failed || group.remaining < 1) return
				group.remaining--
				group.failed = true
			},
		}
	}

	private advanceCursor(releaseWaiters = true): void {
		while (this.pending.length > 0) {
			const first = this.pending[0]
			if (!first || first.failed || first.remaining > 0 || !first.sealed) break
			// Validation above rejects rewound input. Keep this defensive check so a
			// duplicate can never move a confirmed checkpoint backward.
			if (this.confirmedCursor === undefined || first.seq > this.confirmedCursor) {
				this.confirmedCursor = first.seq
			}
			this.pending.shift()
		}
		if (releaseWaiters) this.releaseWaiters()
	}

	private releaseWaiters(): void {
		while (this.accepting && this.waiters.length > 0) {
			const waiter = this.waiters[0]
			if (!waiter) return
			if (!isValidFirehoseSeq(waiter.seq) || this.isStaleOrRewound(waiter.seq)) {
				this.waiters.shift()?.resolve(undefined)
				continue
			}

			const reservation = this.admit(waiter.seq, false)
			if (reservation === null) return
			this.waiters.shift()?.resolve(reservation)
		}
	}
}
