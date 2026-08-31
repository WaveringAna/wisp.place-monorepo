import { describe, expect, test } from 'bun:test'
import { assertValidAtprotoRevision, isValidAtprotoRevision } from './atproto-revision'

describe('ATProto revision validation', () => {
	test('accepts only canonical TIDs shared by intake and outbox', () => {
		expect(isValidAtprotoRevision('3lq6x5f2abcde')).toBe(true)
		expect(isValidAtprotoRevision('2aaaaaaaaaaaa')).toBe(true)
		expect(isValidAtprotoRevision('zaaaaaaaaaaaa')).toBe(false) // first char is constrained by TID syntax
		expect(isValidAtprotoRevision('3lq6x5f2abcde0')).toBe(false)
		expect(isValidAtprotoRevision('3lq6x5f2abcd0')).toBe(false)
		expect(() => assertValidAtprotoRevision('invalid')).toThrow('Invalid ATProto revision')
	})
})
