import { isValidTid } from '@atproto/syntax'

/**
 * Jetstream commit revisions are ATProto TIDs. Keep this validator shared so
 * intake, cursor/index state, and outbox identity reject the same bad input.
 */
export function isValidAtprotoRevision(value: unknown): value is string {
	return typeof value === 'string' && value.length === 13 && isValidTid(value)
}

export function assertValidAtprotoRevision(value: unknown): asserts value is string {
	if (!isValidAtprotoRevision(value)) throw new Error('Invalid ATProto revision')
}
