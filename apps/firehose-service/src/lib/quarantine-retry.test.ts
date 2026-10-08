import { describe, expect, test } from 'bun:test'
import {
	parseFenceField,
	QUARANTINE_RETRY_SCHEDULE_MS,
	quarantineClass,
	retryDelayMs,
	summarizeFences,
} from './quarantine-retry'

const deadLetter = (classification: string, errorCode: string, quarantinedAt = 0) => ({
	classification,
	errorCode,
	quarantinedAt,
})

describe('quarantine retry policy', () => {
	test('retries transient dead letters and MAX_ATTEMPTS, never permanent or unreadable ones', () => {
		for (const code of ['FETCH_FAILED', 'REVALIDATION_DEADLINE', 'TRANSFER_BUDGET_EXCEEDED', 'Error']) {
			expect(quarantineClass(deadLetter('transient', code))).toBe('transient')
		}
		expect(quarantineClass(deadLetter('permanent', 'MAX_ATTEMPTS'))).toBe('transient')
		for (const code of ['BLOB_SIZE_MISMATCH', 'INVALID_RECORD', 'REPAIR_QUARANTINED']) {
			expect(quarantineClass(deadLetter('permanent', code))).toBe('permanent')
		}
		expect(quarantineClass(null)).toBe('unknown')
		expect(quarantineClass(deadLetter('', ''))).toBe('unknown')
	})

	test('schedule is 15 min, 1 h, 6 h, 24 h with at most 10% jitter either way', () => {
		expect(QUARANTINE_RETRY_SCHEDULE_MS).toEqual([900_000, 3_600_000, 21_600_000, 86_400_000])
		for (const [attempts, base] of QUARANTINE_RETRY_SCHEDULE_MS.entries()) {
			expect(retryDelayMs(attempts, () => 0)).toBe((base * 9) / 10)
			expect(retryDelayMs(attempts, () => 1)).toBe((base * 11) / 10)
		}
		expect(retryDelayMs(99, () => 0.5)).toBe(86_400_000)
	})

	test('only exact, encoded did/rkey fence keys name a site', () => {
		expect(parseFenceField('did%3Aplc%3Aabc/self')).toEqual({ did: 'did:plc:abc', rkey: 'self' })
		for (const field of ['did%3Aplc%3Aabc', 'a/b/c', 'handle.test/site', 'did%3Aplc%3Aabc/..', '%E0%A4%A/site']) {
			expect(parseFenceField(field)).toBeNull()
		}
	})

	test('summarizes fences by class and reports the oldest dead letter', () => {
		const site = (classification: string, quarantinedAt: number) => ({
			field: '',
			did: '',
			rkey: '',
			fence: '',
			generation: null,
			deadLetter: deadLetter(classification, 'X', quarantinedAt),
			state: null,
		})
		const now = 10 * 3_600_000
		expect(
			summarizeFences([site('transient', now - 3_600_000), site('permanent', now - 7_200_000)], 2, 581, now),
		).toEqual({
			fenced: { transient: 1, permanent: 1, unknown: 2 },
			dlqEntries: 581,
			oldestFenceAgeSeconds: 7200,
		})
		expect(summarizeFences([], 0, 0, now).oldestFenceAgeSeconds).toBe(0)
	})
})
