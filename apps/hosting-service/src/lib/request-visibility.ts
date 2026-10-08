import {
	type HostingNotFoundReason,
	type HostingResponseEntry,
	type HostingResponseKind,
	type HostingStatusClass,
	type HostingTier,
	metricsCollector,
} from '@wispplace/observability'
import type { Context, Next } from 'hono'
import { notFoundLog } from './not-found-log'

/**
 * Where hosting time goes and what its 404s are.
 *
 * Every response is timed to its headers and exported as
 * `hosting_response_time_ms{tier,status_class,kind}`; every 404 increments
 * `hosting_not_found_total{reason}` and the aggregated not-found log. Labels
 * come from closed sets only: hosts reach the log, never a metric.
 */

type NotFoundTag = { reason: HostingNotFoundReason; host?: string }

// Why a request ended in 404, set by the code that chose to answer it. Keyed by
// the request because Hono may replace the handler's response with a copy.
const notFoundTags = new WeakMap<Request, NotFoundTag>()

// Site 404s answered by a `_redirects` 404 rule rather than a missing file.
const redirectNotFoundResponses = new WeakSet<Response>()

// Probes, not site traffic: timing them would dilute the site latency.
const UNTIMED_PATHS = new Set(['/health', '/live'])

export function tagNotFound(request: Request, reason: HostingNotFoundReason, host?: string): void {
	notFoundTags.set(request, { reason, host })
}

export function markRedirectNotFound(response: Response): Response {
	redirectNotFoundResponses.add(response)
	return response
}

/** Why a site answered 404: a `_redirects` rule or a missing file. */
export function siteNotFoundReason(response: Response): HostingNotFoundReason | null {
	if (response.status !== 404) return null
	return redirectNotFoundResponses.has(response) ? 'redirect-404' : 'file-not-found'
}

export function tagSiteNotFound(request: Request, response: Response, host?: string): void {
	const reason = siteNotFoundReason(response)
	if (reason) tagNotFound(request, reason, host)
}

export function servedTier(cacheTier: string | null): HostingTier {
	return cacheTier === 'hot' || cacheTier === 'warm' || cacheTier === 'cold' ? cacheTier : 'none'
}

export function hostingStatusClass(status: number): HostingStatusClass | null {
	if (status >= 200 && status < 300) return '2xx'
	if (status >= 300 && status < 400) return '3xx'
	if (status === 404) return '404'
	if (status >= 400 && status < 500) return '4xx'
	if (status >= 500 && status < 600) return '5xx'
	return null
}

/** HTML pages, other stored files, and everything hosting generated itself. */
export function responseKind(contentType: string | null, tier: HostingTier): HostingResponseKind {
	if (contentType?.toLowerCase().startsWith('text/html')) return 'html'
	return tier === 'none' ? 'other' : 'asset'
}

export function hostingResponseEntry(response: Response, durationMs: number): HostingResponseEntry | null {
	const statusClass = hostingStatusClass(response.status)
	if (!statusClass) return null
	const tier = servedTier(response.headers.get('x-cache-tier'))
	return { tier, statusClass, kind: responseKind(response.headers.get('content-type'), tier), durationMs }
}

function recordNotFound(reason: HostingNotFoundReason, host: string): void {
	metricsCollector.recordHostingNotFound(reason)
	notFoundLog.record(reason, host)
}

export type RequestVisibilityOptions = {
	recordResponse?: (entry: HostingResponseEntry) => void
	recordNotFound?: (reason: HostingNotFoundReason, host: string) => void
}

export function requestVisibility(options: RequestVisibilityOptions = {}) {
	const record = options.recordResponse ?? metricsCollector.recordHostingResponse
	const recordMissing = options.recordNotFound ?? recordNotFound

	return async (c: Context, next: Next): Promise<void> => {
		if (UNTIMED_PATHS.has(c.req.path)) return next()
		const startedAt = performance.now()
		await next()
		const entry = hostingResponseEntry(c.res, performance.now() - startedAt)
		if (entry) record(entry)
		if (c.res.status !== 404) return
		const tag = notFoundTags.get(c.req.raw)
		recordMissing(tag?.reason ?? 'other', tag?.host ?? new URL(c.req.url).hostname)
	}
}
