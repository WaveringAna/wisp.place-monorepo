import { describe, expect, it } from 'bun:test'
import { parseCookieHeader } from './session-cookie'

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
