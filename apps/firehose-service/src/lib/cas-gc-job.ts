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
let timers: Array<ReturnType<typeof setTimeout>> = []
let controller: AbortController | null = null
let active: Promise<unknown> | null = null

/** Leader-only: started and stopped with the revalidation worker. Two collectors would only contend on row locks. */
export function startCasGarbageCollector(config: CasGcConfig = resolveCasGcConfig()): void {
	if (controller) return
	const own = new AbortController()
	controller = own
	const every = (intervalMs: number, name: string, work: () => Promise<Record<string, unknown>>) => {
		const schedule = (delayMs: number) => {
			const timer = setTimeout(async () => {
				if (own.signal.aborted) return
				active = work()
					.then((result) => logger.info(`[CasGc] ${name} complete`, result))
					.catch(() => logger.warn(`[CasGc] ${name} failed`))
				await active
				active = null
				if (!own.signal.aborted) schedule(intervalMs)
			}, delayMs)
			timer.unref?.()
			timers.push(timer)
		}
		schedule(FIRST_RUN_DELAY_MS)
	}
	every(config.collectIntervalMs, 'Collection', async () => ({
		...(await runCollectionTick(config, defaultDependencies, own.signal)),
	}))
	every(config.reconcileIntervalMs, 'Reconcile', async () => ({
		...(await runReconcileTick(config, defaultDependencies, own.signal)),
	}))
}

export async function stopCasGarbageCollector(): Promise<void> {
	controller?.abort()
	controller = null
	for (const timer of timers) clearTimeout(timer)
	timers = []
	await active?.catch(() => undefined)
}
