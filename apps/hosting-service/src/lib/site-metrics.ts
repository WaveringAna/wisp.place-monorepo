import { metricsCollector, type SiteRequestEntry, type SiteStatusClass } from '@wispplace/observability'

/**
 * Per-site traffic, exported as the `site_requests_total` Prometheus counter.
 * Aggregation and retention live in VictoriaMetrics; nothing is buffered here
 * and nothing is written to the database.
 */

type Recorder = (entry: SiteRequestEntry) => void

export function statusClassFor(statusCode: number): SiteStatusClass | null {
	if (statusCode >= 200 && statusCode < 300) return '2xx'
	if (statusCode >= 300 && statusCode < 400) return '3xx'
	if (statusCode >= 400 && statusCode < 500) return '4xx'
	if (statusCode >= 500 && statusCode < 600) return '5xx'
	return null
}

/** Only GETs against an identified site count as traffic. */
export function siteRequestEntry(
	ownerDid: string,
	siteRkey: string,
	method: string,
	statusCode: number,
	contentType: string | null,
): SiteRequestEntry | null {
	if (method !== 'GET' || !ownerDid || !siteRkey) return null
	const statusClass = statusClassFor(statusCode)
	if (!statusClass) return null
	return {
		ownerDid,
		siteRkey,
		statusClass,
		html: contentType?.toLowerCase().startsWith('text/html') ?? false,
	}
}

export function recordSiteResponse(
	ownerDid: string,
	siteRkey: string,
	method: string,
	statusCode: number,
	contentType: string | null,
	record: Recorder = metricsCollector.recordSiteRequest,
): void {
	const entry = siteRequestEntry(ownerDid, siteRkey, method, statusCode, contentType)
	if (entry) record(entry)
}
