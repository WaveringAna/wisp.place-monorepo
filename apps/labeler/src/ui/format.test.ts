import { describe, expect, test } from 'bun:test'
import type { ModerationEvent } from '../moderation/types'
import { actorName, ago, describeEvent, eventSubject, parseSiteUri, shortDid } from './format'
import { commandForKey } from './keys'
import { formatRoute, parseRoute } from './route'

const NOW = Date.parse('2026-10-15T12:00:00Z')

describe('ago', () => {
	test('rounds down to the largest unit', () => {
		expect(ago('2026-10-15T11:59:30Z', NOW)).toBe('just now')
		expect(ago('2026-10-15T11:55:00Z', NOW)).toBe('5m')
		expect(ago('2026-10-15T09:00:00Z', NOW)).toBe('3h')
		expect(ago('2026-10-13T12:00:00Z', NOW)).toBe('2d')
		expect(ago('2026-09-01T12:00:00Z', NOW)).toBe('1mo')
		expect(ago('nonsense', NOW)).toBe('')
	})
})

test('shortDid and parseSiteUri', () => {
	expect(shortDid('did:plc:abcdefghijklmnopqrstuvwx')).toBe('did:plc:abcd…uvwx')
	expect(shortDid('did:web:example.com')).toBe('did:web:example.com')
	expect(parseSiteUri('at://did:plc:x/place.wisp.fs/blog')).toEqual({ did: 'did:plc:x', rkey: 'blog' })
	expect(parseSiteUri('did:plc:x')).toBeNull()
})

test('describeEvent reads the keys it knows', () => {
	const event = (kind: ModerationEvent['kind'], data: Record<string, unknown>): ModerationEvent => ({
		id: 1,
		subject: 'did:plc:x',
		kind,
		actor: 'system',
		data,
		at: '2026-10-15T12:00:00Z',
		handle: null,
		title: null,
	})
	expect(describeEvent(event('triaged', { flag: true, category: 'phishing', reason: 'login form' }))).toBe(
		'flagged as phishing: login form',
	)
	expect(describeEvent(event('verdict', { verdict: 'spam', note: 'ring' }))).toBe('verdict spam (ring)')
	expect(describeEvent(event('verdict', { verdict: null }))).toBe('verdict cleared')
	expect(describeEvent(event('label', { val: '!takedown', neg: true }))).toBe('restored !takedown')
	expect(actorName('model:bonsai', null)).toBe('bonsai')
	expect(actorName('did:plc:me', { did: 'did:plc:me', handle: 'okami.mom' })).toBe('@okami.mom')
})

describe('routes', () => {
	test('round-trip and default to flagged', () => {
		for (const route of [
			{ kind: 'queue', view: 'pending' },
			{ kind: 'search', q: 'a b&c' },
			{ kind: 'activity' },
			{ kind: 'account', did: 'did:plc:abc' },
		] as const) {
			expect(parseRoute(formatRoute(route))).toEqual(route)
		}
		expect(parseRoute('')).toEqual({ kind: 'queue', view: 'flagged' })
		expect(parseRoute('#/nope')).toEqual({ kind: 'queue', view: 'flagged' })
	})
})

describe('keys', () => {
	const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
		key: k,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		...mods,
	})
	test('maps the documented keys', () => {
		expect(commandForKey(key('j'), false)).toEqual({ kind: 'move', by: 1 })
		expect(commandForKey(key('m'), false)).toEqual({ kind: 'verdict', verdict: 'mass-created' })
		expect(commandForKey(key('/'), false)).toEqual({ kind: 'search' })
		expect(commandForKey(key('x'), false)).toBeNull()
	})
	test('leaves typing and modified keys alone, except Escape', () => {
		expect(commandForKey(key('s'), true)).toBeNull()
		expect(commandForKey(key('s', { metaKey: true }), false)).toBeNull()
		expect(commandForKey(key('Escape'), true)).toEqual({ kind: 'escape' })
	})
})

test('eventSubject prefers handle and title, falling back to rkey or a short DID', () => {
	const base: ModerationEvent = {
		id: 1,
		subject: 'at://did:plc:abcdefghijklmnopqrstuvwx/place.wisp.fs/blog',
		kind: 'seen',
		actor: 'system',
		data: {},
		at: '2026-10-15T12:00:00Z',
		handle: 'alice.test',
		title: 'Alice writes',
	}
	expect(eventSubject(base)).toBe('@alice.test · Alice writes')
	expect(eventSubject({ ...base, title: null })).toBe('@alice.test · blog')
	expect(eventSubject({ ...base, handle: null, title: null })).toBe('blog')
	expect(eventSubject({ ...base, subject: 'did:plc:abcdefghijklmnopqrstuvwx', title: null })).toBe('@alice.test')
	expect(eventSubject({ ...base, subject: 'did:plc:abcdefghijklmnopqrstuvwx', handle: null })).toBe('did:plc:abcd…uvwx')
})
