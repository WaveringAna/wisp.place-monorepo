/**
 * Canonical revalidation stream names shared by every producer and consumer.
 *
 * The work stream and its dead-letter stream are deliberately separate: the
 * DLQ is a quarantine fence with a different schema (sourceId, errorCode,
 * classification, attempts) and a manual replay lifecycle, so it must never be
 * folded into the live work stream. Emergency or paused copies of the work
 * stream are operational duplicates; this module is the single source of truth
 * for the canonical names so producers and consumers cannot drift apart.
 */
export const DEFAULT_REVALIDATE_STREAM = 'wisp:revalidate'
export const DEFAULT_REVALIDATE_STREAM_CAPACITY = 1_000_000
export const DEFAULT_REVALIDATE_DLQ_STREAM = 'wisp:revalidate:dlq'

/**
 * Durable per-site fence installed when repair work reaches the DLQ.
 *
 * Hosting producers must not recreate work behind this fence. Only a newer
 * firehose event may clear it before reconciling the authoritative record.
 */
export function revalidationQuarantineKey(did: string, rkey: string): string {
	return `wisp:revalidate:quarantine:${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`
}

/** Latest successfully reconciled ATProto repo revision for one site. */
export function revalidationSiteVersionKey(did: string, rkey: string): string {
	return `wisp:revalidate:version:${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`
}
