import { createLogger } from '@wispplace/observability'
import type { EnqueueResult } from './revalidate-queue'

/**
 * Aggregated visibility for hosting's deliberate fail-closed 503s.
 *
 * Each 503 is counted under its site and reason, and one summary line per
 * (site, reason) is logged when the window flushes, never one per request.
 * Distinct sites per window are capped; the rest are counted under `other`.
 * Lines carry the site's did/rkey and nothing from the request itself.
 */

export type UnavailableReason = 'updating' | 'manifest-miss' | 'cid-miss' | 'cid-mismatch' | 'storage-unavailable'

/** What the 503 did about repair: the queue's answer, or `none` when it does not request one. */
export type RevalidateOutcome = EnqueueResult | 'none'

export type UnavailableSummary = {
	site: string
	reason: UnavailableReason
	count: number
	firstAt: string
	lastAt: string
	revalidate: Partial<Record<RevalidateOutcome, number>>
}

type Bucket = Omit<UnavailableSummary, 'firstAt' | 'lastAt'> & { firstAt: number; lastAt: number }

export type UnavailableLogOptions = {
	maxSites?: number
	windowMs?: number
	emit?: (summary: UnavailableSummary) => void
	now?: () => number
}

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_SITES = 500
export const OVERFLOW_SITE = 'other'

const logger = createLogger('hosting-service')

function logSummary(summary: UnavailableSummary): void {
	logger.info('[FailClosed] 503 summary', summary)
}

function toSummary(bucket: Bucket): UnavailableSummary {
	return {
		site: bucket.site,
		reason: bucket.reason,
		count: bucket.count,
		firstAt: new Date(bucket.firstAt).toISOString(),
		lastAt: new Date(bucket.lastAt).toISOString(),
		revalidate: bucket.revalidate,
	}
}

export function createUnavailableLog(options: UnavailableLogOptions = {}) {
	const maxSites = options.maxSites ?? DEFAULT_MAX_SITES
	const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
	const emit = options.emit ?? logSummary
	const now = options.now ?? Date.now
	// Keyed by site then reason; the reason set is closed, so the cap on sites bounds the whole window.
	let sites = new Map<string, Map<UnavailableReason, Bucket>>()
	let timer: ReturnType<typeof setInterval> | null = null

	function siteKey(site: string): string {
		return sites.has(site) || sites.size < maxSites ? site : OVERFLOW_SITE
	}

	function record(did: string, rkey: string, reason: UnavailableReason, revalidate: RevalidateOutcome): void {
		const at = now()
		const site = siteKey(`${did}/${rkey}`)
		let buckets = sites.get(site)
		if (!buckets) {
			buckets = new Map()
			sites.set(site, buckets)
		}
		const bucket = buckets.get(reason)
		if (!bucket) {
			buckets.set(reason, { site, reason, count: 1, firstAt: at, lastAt: at, revalidate: { [revalidate]: 1 } })
			return
		}
		bucket.count++
		bucket.lastAt = at
		bucket.revalidate[revalidate] = (bucket.revalidate[revalidate] ?? 0) + 1
	}

	/** Emit one line per (site, reason) seen since the last flush and start a new window. */
	function flush(): number {
		const finished = sites
		sites = new Map()
		let lines = 0
		for (const buckets of finished.values()) {
			for (const bucket of buckets.values()) {
				emit(toSummary(bucket))
				lines++
			}
		}
		return lines
	}

	function start(): void {
		if (timer) return
		timer = setInterval(flush, windowMs)
		// Visibility must never keep the process alive.
		timer.unref?.()
	}

	function stop(): number {
		if (timer) clearInterval(timer)
		timer = null
		return flush()
	}

	return { record, flush, start, stop, trackedSites: () => sites.size }
}

export const unavailableLog = createUnavailableLog()
