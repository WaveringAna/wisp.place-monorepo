import { describe, expect, test } from 'bun:test'
import { shouldSkipInvalidationForReason } from './revalidate-worker'

describe('shouldSkipInvalidationForReason', () => {
	test('skips invalidation for rewrite repair jobs', () => {
		expect(shouldSkipInvalidationForReason('rewrite-miss:docs/w/~/index.html')).toBe(true)
	})

	test('does not skip invalidation for storage misses', () => {
		expect(shouldSkipInvalidationForReason('storage-miss:docs/raw/README.md')).toBe(false)
	})

	test('does not skip invalidation for other revalidate reasons', () => {
		expect(shouldSkipInvalidationForReason('manual')).toBe(false)
	})
})
