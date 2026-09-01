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
