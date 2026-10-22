import { createLogger } from '@wispplace/observability'
import type { CasGcOptions, CasGcResult, CasReconcileOptions, CasReconcileResult } from './cas-gc'
import { runCasCollection, runCasReconcile } from './db'
import { deleteFile } from './storage'

const logger = createLogger('firehose-service')

export interface CasGcConfig {
	/** How long an object must be unreferenced before it may be deleted. Must outlast any site update. */
	graceSeconds: number
	collectIntervalMs: number
	reconcileIntervalMs: number
	batch: number
	maxPassesPerTick: number
	reconcileBatch: number
}

function boundedInteger(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
	if (raw === undefined || !/^\d+$/.test(raw)) return fallback
	const value = Number(raw)
	return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback
}

/** Resolve settings without accepting a value that could shorten the grace period into a data-loss risk. */
export function resolveCasGcConfig(environment: Record<string, string | undefined> = process.env): CasGcConfig {
	return {
		graceSeconds: boundedInteger(environment.CAS_GC_GRACE_SECONDS, 86_400, 3_600, 30 * 86_400),
		collectIntervalMs: boundedInteger(environment.CAS_GC_INTERVAL_MS, 3_600_000, 60_000, 86_400_000),
		reconcileIntervalMs: boundedInteger(environment.CAS_GC_RECONCILE_INTERVAL_MS, 86_400_000, 3_600_000, 604_800_000),
		batch: boundedInteger(environment.CAS_GC_BATCH, 500, 10, 5_000),
		maxPassesPerTick: 20,
		reconcileBatch: 1_000,
	}
}

export interface CasGcJobDependencies {
	collect(options: Pick<CasGcOptions, 'graceSeconds' | 'limit'>): Promise<CasGcResult>
	reconcile(options: Pick<CasReconcileOptions, 'limit'>): Promise<CasReconcileResult>
}

const defaultDependencies: CasGcJobDependencies = {
	collect: (options) => runCasCollection({ deleteObject: deleteFile }, options),
	reconcile: (options) => runCasReconcile(options),
}

export interface CollectionTickResult extends CasGcResult {
	passes: number
	errored?: true
}

/** Bounded passes: repeat only while each one deletes a full batch, so skipped or failing rows never spin it. */
export async function runCollectionTick(
	config: CasGcConfig,
	dependencies: CasGcJobDependencies = defaultDependencies,
	signal?: AbortSignal,
): Promise<CollectionTickResult> {
	const total: CollectionTickResult = { passes: 0, deleted: 0, skipped: 0, failed: 0 }
	while (total.passes < config.maxPassesPerTick && !signal?.aborted) {
		let pass: CasGcResult
		try {
			pass = await dependencies.collect({ graceSeconds: config.graceSeconds, limit: config.batch })
		} catch {
			return { ...total, errored: true }
		}
		total.passes++
		total.deleted += pass.deleted
		total.skipped += pass.skipped
		total.failed += pass.failed
		if (pass.deleted < config.batch) break
	}
	return total
}

export interface ReconcileTickResult extends CasReconcileResult {
	passes: number
	errored?: true
}

/** Repeat while passes keep repairing; counts that merely raced with live updates are left for next time. */
export async function runReconcileTick(
	config: CasGcConfig,
	dependencies: CasGcJobDependencies = defaultDependencies,
	signal?: AbortSignal,
): Promise<ReconcileTickResult> {
	const total: ReconcileTickResult = { passes: 0, repaired: 0, raced: 0 }
	while (total.passes < config.maxPassesPerTick && !signal?.aborted) {
		let pass: CasReconcileResult
		try {
			pass = await dependencies.reconcile({ limit: config.reconcileBatch })
		} catch {
			return { ...total, errored: true }
		}
		total.passes++
		total.repaired += pass.repaired
		total.raced += pass.raced
		if (pass.repaired === 0) break
	}
	return total
}

const FIRST_RUN_DELAY_MS = 15 * 60 * 1000

export interface CasGcJob {
	name: string
	intervalMs: number
	run(signal: AbortSignal): Promise<Record<string, unknown>>
}

export function casGcJobs(config: CasGcConfig, dependencies: CasGcJobDependencies = defaultDependencies): CasGcJob[] {
	return [
		{
			name: 'Collection',
			intervalMs: config.collectIntervalMs,
			run: async (signal) => ({ ...(await runCollectionTick(config, dependencies, signal)) }),
		},
		{
			name: 'Reconcile',
			intervalMs: config.reconcileIntervalMs,
			run: async (signal) => ({ ...(await runReconcileTick(config, dependencies, signal)) }),
		},
	]
}

export interface CasGcClock {
	set(callback: () => void, delayMs: number): unknown
	clear(handle: unknown): void
}

const realClock: CasGcClock = {
	set(callback, delayMs) {
		const timer = setTimeout(callback, delayMs)
		timer.unref?.()
		return timer
	},
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface CasGcScheduler {
	start(jobs: CasGcJob[]): void
	stop(): Promise<void>
}

/**
 * Each generation waits for the previous one to drain before its first pass, so a restart never overlaps
 * SQL or S3 work that a stop has aborted but not yet settled. Stop resolves only once every pass has.
 */
export function createCasGcScheduler(
	firstRunDelayMs = FIRST_RUN_DELAY_MS,
	clock: CasGcClock = realClock,
): CasGcScheduler {
	let stopCurrent: (() => Promise<void>) | null = null
	let drained: Promise<void> = Promise.resolve()
	return {
		start(jobs) {
			if (stopCurrent) return
			const own = new AbortController()
			const previous = drained
			const timers = new Set<unknown>()
			const inFlight = new Set<Promise<void>>()
			const pass = async (job: CasGcJob) => {
				await previous
				if (own.signal.aborted) return
				try {
					logger.info(`[CasGc] ${job.name} complete`, await job.run(own.signal))
				} catch {
					logger.warn(`[CasGc] ${job.name} failed`)
				}
				if (!own.signal.aborted) schedule(job, job.intervalMs)
			}
			const schedule = (job: CasGcJob, delayMs: number) => {
				const timer = clock.set(() => {
					timers.delete(timer)
					const running = pass(job).finally(() => inFlight.delete(running))
					inFlight.add(running)
				}, delayMs)
				timers.add(timer)
			}
			for (const job of jobs) schedule(job, firstRunDelayMs)
			stopCurrent = async () => {
				own.abort()
				for (const timer of timers) clock.clear(timer)
				timers.clear()
				await previous
				while (inFlight.size > 0) await Promise.allSettled(inFlight)
			}
		},
		stop() {
			if (stopCurrent) {
				drained = stopCurrent()
				stopCurrent = null
			}
			return drained
		},
	}
}

const scheduler = createCasGcScheduler()

/** Leader-only: started and stopped with the revalidation worker. Two collectors would only contend on row locks. */
export function startCasGarbageCollector(config: CasGcConfig = resolveCasGcConfig()): void {
	scheduler.start(casGcJobs(config))
}

export function stopCasGarbageCollector(): Promise<void> {
	return scheduler.stop()
}
