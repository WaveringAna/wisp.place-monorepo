import { createLogger } from '@wispplace/observability'
import type { AllTierStats } from '@wispplace/tiered-storage'

const logger = createLogger('firehose-service')

/** Long bounded interval for expensive full storage-stat refreshes. */
export const STORAGE_STATS_REFRESH_INTERVAL_MS = 60 * 60 * 1_000
/** Age after which capacity data is no longer ready for health reporting. */
export const STORAGE_STATS_STALE_AFTER_MS = STORAGE_STATS_REFRESH_INTERVAL_MS * 2

/** Safe error categories for cached storage statistics. */
export type StorageStatsErrorKind = 'StorageError' | 'UnknownError'

/** Constant-time in-memory result of the most recent storage-stat refresh. */
export interface StorageStatsSnapshot {
	stats: AllTierStats | null
	lastSuccessAgeMs: number | null
	lastErrorKind: StorageStatsErrorKind | null
	stale: boolean
	refreshing: boolean
}

/** Function that performs an expensive complete storage-stat scan. */
export type StorageStatsFetcher = () => Promise<AllTierStats>

/**
 * A single-flight, low-frequency cache for expensive storage capacity stats.
 * `getSnapshot` only reads local values, so health checks never await or begin
 * a paginated S3 scan. Stopping the schedule invalidates queued timer work
 * before it can invoke its fetcher.
 */
export class StorageStatsCache {
	private cachedStats: AllTierStats | null = null
	private lastSuccessAt: number | null = null
	private lastErrorKind: StorageStatsErrorKind | null = null
	private refreshInFlight: Promise<void> | null = null
	private refreshTimer: ReturnType<typeof setInterval> | null = null
	private scheduleGeneration = 0

	/**
	 * @param getStats Expensive full-stat operation to run outside health handlers
	 */
	constructor(private readonly getStats: StorageStatsFetcher) {}

	/**
	 * Read the cached state without starting or waiting for storage I/O.
	 *
	 * @param now Optional clock value for deterministic callers
	 * @returns Safe cached readiness data
	 */
	getSnapshot(now = Date.now()): StorageStatsSnapshot {
		const lastSuccessAgeMs = this.lastSuccessAt === null ? null : Math.max(0, now - this.lastSuccessAt)
		return {
			stats: this.cachedStats,
			lastSuccessAgeMs,
			lastErrorKind: this.lastErrorKind,
			stale: lastSuccessAgeMs === null || lastSuccessAgeMs > STORAGE_STATS_STALE_AFTER_MS,
			refreshing: this.refreshInFlight !== null,
		}
	}

	/**
	 * Perform one explicit single-flight refresh. This remains available for
	 * controlled startup/admin work and is not called by health requests.
	 *
	 * @returns Completion of the current refresh
	 */
	refresh(): Promise<void> {
		return this.beginRefresh()
	}

	/** Start the unref'd background refresh schedule. */
	start(): void {
		if (this.refreshTimer) return

		const generation = ++this.scheduleGeneration
		this.scheduleRefresh(generation)
		this.refreshTimer = setInterval(() => {
			this.scheduleRefresh(generation)
		}, STORAGE_STATS_REFRESH_INTERVAL_MS)
		this.refreshTimer.unref?.()
	}

	/**
	 * Stop future scheduled refreshes. A fetch already entered by the provider
	 * cannot be cancelled generically, but queued timer work is fenced out and
	 * its eventual result is ignored after this stop.
	 */
	stop(): void {
		this.scheduleGeneration++
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer)
			this.refreshTimer = null
		}
	}

	private scheduleRefresh(generation: number): void {
		if (generation !== this.scheduleGeneration) return
		void this.beginRefresh(generation)
	}

	private beginRefresh(scheduleGeneration?: number): Promise<void> {
		if (this.refreshInFlight) return this.refreshInFlight

		const refresh = Promise.resolve()
			.then(async () => {
				// `stop()` can run between timer callback scheduling and this microtask.
				// Do not initiate I/O after a stopped test/service schedule.
				if (scheduleGeneration !== undefined && scheduleGeneration !== this.scheduleGeneration) return null
				return await this.getStats()
			})
			.then((stats) => {
				if (stats === null || (scheduleGeneration !== undefined && scheduleGeneration !== this.scheduleGeneration)) {
					return
				}
				this.cachedStats = stats
				this.lastSuccessAt = Date.now()
				this.lastErrorKind = null
			})
			.catch((error) => {
				if (scheduleGeneration !== undefined && scheduleGeneration !== this.scheduleGeneration) return
				// Do not expose provider messages or names: they can contain request URLs.
				this.lastErrorKind = error instanceof Error ? 'StorageError' : 'UnknownError'
				logger.warn('[Storage] Statistics refresh failed', { errorKind: this.lastErrorKind })
			})
			.finally(() => {
				if (this.refreshInFlight === refresh) this.refreshInFlight = null
			})

		this.refreshInFlight = refresh
		return refresh
	}
}
