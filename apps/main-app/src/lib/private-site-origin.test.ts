import { afterEach, describe, expect, test } from 'bun:test'
import { normalizePrivateHost, privateHost, privateHostname, privateSiteUrl } from './private-site-origin'

const ORIGINAL_PRIVATE_HOST = process.env.PRIVATE_HOST
const ORIGINAL_LOCAL_DEV = process.env.LOCAL_DEV

const restoreEnv = (name: 'PRIVATE_HOST' | 'LOCAL_DEV', value: string | undefined): void => {
	if (value === undefined) {
		delete process.env[name]
	} else {
		process.env[name] = value
	}
}

afterEach(() => {
	restoreEnv('PRIVATE_HOST', ORIGINAL_PRIVATE_HOST)
	restoreEnv('LOCAL_DEV', ORIGINAL_LOCAL_DEV)
})

describe('private host configuration', () => {
	test('normalizes a bare hostname while retaining a non-default port for local links', () => {
		expect(normalizePrivateHost(' PRIV.WISP.LOCALHOST:3001 ', 'priv.fallback.test')).toEqual({
			host: 'priv.wisp.localhost:3001',
			hostname: 'priv.wisp.localhost',
		})
		expect(normalizePrivateHost('priv.wisp.place.:444', 'priv.fallback.test')).toEqual({
			host: 'priv.wisp.place:444',
			hostname: 'priv.wisp.place',
		})
	})

	test('falls back for non-host values instead of accepting credentials, paths, or origins', () => {
		const fallback = { host: 'priv.fallback.test', hostname: 'priv.fallback.test' }
		for (const value of [
			'https://priv.wisp.place',
			'user:password@priv.wisp.place',
			'priv.wisp.place/path',
			'priv.wisp.place?token=secret',
			'priv.wisp.place#fragment',
			'not a hostname',
		]) {
			expect(normalizePrivateHost(value, 'priv.fallback.test')).toEqual(fallback)
		}
	})

	test('uses the canonical hostname for matching but preserves the local port in generated links', () => {
		process.env.PRIVATE_HOST = 'PRIV.WISP.LOCALHOST:3001'
		process.env.LOCAL_DEV = 'true'

		expect(privateHostname()).toBe('priv.wisp.localhost')
		expect(privateHost()).toBe('priv.wisp.localhost:3001')
		expect(privateSiteUrl('bright-brook-fox-1234')).toBe('http://bright-brook-fox-1234.priv.wisp.localhost:3001/')
	})
})
