import { describe, expect, it } from 'bun:test'
import { countCookieOccurrences, parseCookieHeader } from './session-cookie'

describe('cookie helpers', () => {
	it.each([
		['a=1; b=2', { a: '1', b: '2' }],
		['wsps=wsx%5Fabc', { wsps: 'wsx_abc' }],
		['novalue; a=1', { a: '1' }],
	])('parses %s', (header, expected) => expect(parseCookieHeader(header)).toEqual(expected))

	it('counts exact duplicate names', () => {
		expect(countCookieOccurrences('wsps=real; wsps=poisoned', 'wsps')).toBe(2)
		expect(countCookieOccurrences('wsps2=a; wspsx=b', 'wsps')).toBe(0)
		expect(countCookieOccurrences('wsps=a; __Host-wsps=b', '__Host-wsps')).toBe(1)
	})
})
