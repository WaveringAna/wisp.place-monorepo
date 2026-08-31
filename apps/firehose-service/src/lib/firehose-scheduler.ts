/**
 * Bounded per-site work scheduling primitives.
 */

class ConcurrencyGate {
	private active = 0
	private readonly waiters: Array<() => void> = []

	constructor(private readonly maxConcurrency: number) {
		if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
			throw new Error('maxConcurrency must be a positive safe integer')
		}
	}

	get inUse(): number {
		return this.active
	}

	async run(handler: () => Promise<void>): Promise<void> {
		await this.acquire()
		try {
			await handler()
		} finally {
			this.release()
		}
	}

	private acquire(): Promise<void> {
		if (this.active < this.maxConcurrency) {
			this.active++
			return Promise.resolve()
		}
		return new Promise((resolve) => this.waiters.push(resolve))
	}

	private release(): void {
		const next = this.waiters.shift()
		if (next) {
			// Hand the occupied slot directly to the next task.
			next()
			return
		}
		this.active--
	}
}

export interface SchedulerDrainResult {
	outcome: 'drained' | 'forced'
	forced: boolean
	remainingWork: number
	activeHandlers: number
}

/**
 * A per-site FIFO scheduler with a shared concurrency limit. The returned
 * promise preserves the handler failure for the cursor tracker, while the
 * internal settled queue lets a later event for that site run in order and be
 * recovered by replay if necessary.
 */
export class SiteWorkScheduler {
	private readonly siteQueues = new Map<string, Promise<void>>()
	private readonly work = new Set<Promise<void>>()
	private readonly gate: ConcurrencyGate
	private queued = 0

	constructor(maxConcurrency: number) {
		this.gate = new ConcurrencyGate(maxConcurrency)
	}

	get queuedHandlers(): number {
		return this.queued
	}

	get activeHandlers(): number {
		return this.gate.inUse
	}

	schedule(siteKey: string, handler: () => Promise<void>): Promise<void> {
		const previous = this.siteQueues.get(siteKey) ?? Promise.resolve()
		this.queued++

		const task = previous.catch(() => undefined).then(() => this.gate.run(handler))
		// Do not make one failed event permanently block later work for the same
		// site. The caller still observes task's rejection and keeps its cursor
		// reservation pending until the relay replays it.
		let settled: Promise<void>
		const finish = () => {
			this.queued = Math.max(0, this.queued - 1)
			this.work.delete(settled)
			if (this.siteQueues.get(siteKey) === settled) this.siteQueues.delete(siteKey)
		}
		settled = task.then(
			() => finish(),
			() => finish(),
		)

		this.siteQueues.set(siteKey, settled)
		this.work.add(settled)
		return task
	}

	async drain(gracePeriodMs: number): Promise<SchedulerDrainResult> {
		if (this.work.size === 0) return this.drainResult('drained')
		if (gracePeriodMs <= 0) return this.drainResult('forced')

		const didDrain = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), gracePeriodMs)
			void this.waitForIdle().then(() => {
				clearTimeout(timer)
				resolve(true)
			})
		})
		return this.drainResult(didDrain ? 'drained' : 'forced')
	}

	private async waitForIdle(): Promise<void> {
		while (this.work.size > 0) {
			await Promise.all(this.work)
		}
	}

	private drainResult(outcome: SchedulerDrainResult['outcome']): SchedulerDrainResult {
		return {
			outcome,
			forced: outcome === 'forced',
			remainingWork: this.queued,
			activeHandlers: this.gate.inUse,
		}
	}
}
