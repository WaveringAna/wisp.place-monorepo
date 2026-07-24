import { describe, expect, it } from 'bun:test'
import { sessionCookieDomain } from './session-cookie-domain'

describe('sessionCookieDomain', () => {
	it('scopes to the registrable domain so the private host receives the cookie', () => {
		expect(sessionCookieDomain('wisp.place')).toBe('wisp.place')
	})

	it('strips a port', () => {
		expect(sessionCookieDomain('wisp.place:8000')).toBe('wisp.place')
	})

	it('strips a legacy leading dot', () => {
		expect(sessionCookieDomain('.wisp.place')).toBe('wisp.place')
	})

	it('leaves the cookie host-only on localhost', () => {
		expect(sessionCookieDomain('localhost')).toBeUndefined()
		expect(sessionCookieDomain('localhost:8000')).toBeUndefined()
	})

	it('leaves the cookie host-only for IP literals', () => {
		expect(sessionCookieDomain('127.0.0.1')).toBeUndefined()
	})

	it('leaves the cookie host-only for single-label hosts', () => {
		expect(sessionCookieDomain('main-app')).toBeUndefined()
	})
})
