import { describe, expect, test } from 'bun:test'
import {
	classifyVerificationFailure,
	isMissingDnsOutcome,
	MAX_DIAGNOSTIC_DETAILS_PER_PASS,
	shouldLogDiagnosticDetail,
} from './dns-verification-logging'

describe('DNS verification logging helpers', () => {
	test('classifies empty TXT and lookup failures as expected missing DNS', () => {
		expect(isMissingDnsOutcome({ verified: false, found: { txt: [] } })).toBe(true)
		expect(isMissingDnsOutcome({ verified: false, error: 'DNS lookup failed: No NS records found' })).toBe(true)
		expect(classifyVerificationFailure({ verified: false, found: { txt: [] } }, true)).toBe('missing-dns')
	})

	test('keeps non-DNS mismatches on verified domains actionable', () => {
		const result = {
			verified: false,
			error: 'TXT record does not match expected DID',
			found: { txt: ['did:plc:another-owner'] },
		}

		expect(isMissingDnsOutcome(result)).toBe(false)
		expect(classifyVerificationFailure(result, true)).toBe('mismatch')
		expect(classifyVerificationFailure(result, false)).toBe('pending')
	})

	test('caps diagnostic detail while allowing the configured sample', () => {
		const emitted = Array.from({ length: MAX_DIAGNOSTIC_DETAILS_PER_PASS + 2 }, (_, index) =>
			shouldLogDiagnosticDetail(index),
		)

		expect(emitted.slice(0, MAX_DIAGNOSTIC_DETAILS_PER_PASS)).toEqual(Array(MAX_DIAGNOSTIC_DETAILS_PER_PASS).fill(true))
		expect(emitted.slice(MAX_DIAGNOSTIC_DETAILS_PER_PASS)).toEqual([false, false])
	})
})
