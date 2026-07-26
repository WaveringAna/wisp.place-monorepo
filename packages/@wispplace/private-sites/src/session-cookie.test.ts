import { describe, expect, it } from 'bun:test'
import { countCookieOccurrences, parseCookieHeader } from './session-cookie'

describe('parseCookieHeader', () => {
	it('parses multiple cookies', () => {
		expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' })
	})

	it('url-decodes values', () => {
		expect(parseCookieHeader('wsps=wsx%5Fabc')).toEqual({ wsps: 'wsx_abc' })
	})

	it('returns empty for a missing header', () => {
		expect(parseCookieHeader(null)).toEqual({})
	})

	it('ignores malformed segments', () => {
		expect(parseCookieHeader('novalue; a=1')).toEqual({ a: '1' })
	})
})

describe('countCookieOccurrences', () => {
	it('counts zero for a missing header or name', () => {
		expect(countCookieOccurrences(null, 'wsps')).toBe(0)
		expect(countCookieOccurrences('a=1; b=2', 'wsps')).toBe(0)
	})

	it('counts a single occurrence', () => {
		expect(countCookieOccurrences('wsps=abc; other=1', 'wsps')).toBe(1)
	})

	/**
	 * A tossed Domain cookie arriving alongside the real host-only one is exactly two
	 * occurrences — this is the shape the duplicate guard exists to reject.
	 */
	it('counts duplicates from a tossed cookie', () => {
		expect(countCookieOccurrences('wsps=real; wsps=poisoned', 'wsps')).toBe(2)
	})

	/** Name matching is exact: a prefix collision must not count. */
	it('does not match prefix collisions', () => {
		expect(countCookieOccurrences('wsps2=abc; wspsx=def', 'wsps')).toBe(0)
	})

	/** The secure name and the dev name are distinct cookies. */
	it('distinguishes the __Host- name from the plain one', () => {
		expect(countCookieOccurrences('wsps=a; __Host-wsps=b', '__Host-wsps')).toBe(1)
		expect(countCookieOccurrences('wsps=a; __Host-wsps=b', 'wsps')).toBe(1)
	})
})
