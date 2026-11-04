import { describe, expect, test } from 'bun:test'
import { KEY_MAX_AGE_S, KEY_PUBLISH_LEAD_S, needsRotation, newKid, signingOrder } from './oauth-key-rotation'

const now = 2_000_000_000

describe('signingOrder', () => {
	test('signs with the newest key that has been published long enough', () => {
		const keys = [
			{ kid: 'old', createdAt: now - KEY_MAX_AGE_S - 10 },
			{ kid: 'current', createdAt: now - 2 * KEY_PUBLISH_LEAD_S },
			{ kid: 'fresh', createdAt: now - 60 },
		]
		expect(signingOrder(keys, now).map((k) => k.kid)).toEqual(['current', 'fresh', 'old'])
	})

	test('a fresh install signs with its only key at once', () => {
		expect(signingOrder([{ kid: 'only', createdAt: now }], now).map((k) => k.kid)).toEqual(['only'])
	})

	test('instances agree on keys created in the same second', () => {
		const a = [
			{ kid: 'key2', createdAt: now - KEY_MAX_AGE_S },
			{ kid: 'key1', createdAt: now - KEY_MAX_AGE_S },
		]
		expect(signingOrder(a, now)[0]?.kid).toBe('key1')
		expect(signingOrder([...a].reverse(), now)[0]?.kid).toBe('key1')
	})
})

describe('needsRotation', () => {
	test('only when the newest key is past its age', () => {
		const stale = { kid: 'a', createdAt: now - KEY_MAX_AGE_S - 1 }
		expect(needsRotation([stale], now)).toBe(true)
		expect(needsRotation([stale, { kid: 'b', createdAt: now - 10 }], now)).toBe(false)
		expect(needsRotation([], now)).toBe(true)
	})
})

test('newKid never repeats', () => {
	expect(newKid(now)).toMatch(/^key-\d{8}-[0-9a-f]{8}$/)
	expect(newKid(now)).not.toBe(newKid(now))
})
