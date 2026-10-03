import { describe, expect, test } from 'bun:test'
import { resolveConfig } from './config'

const valid = {
	BOT_HANDLE: 'wisp.place',
	BOT_PASSWORD: 'app-password-secret',
	DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/wisp',
	PREVIEW_HOST: 'wispsites.dev',
}

describe('resolveConfig', () => {
	test('resolves explicit configuration', () => {
		const config = resolveConfig(valid)

		expect(config.botHandle).toBe('wisp.place')
		expect(config.botPassword).toBe('app-password-secret')
		expect(config.databaseUrl).toBe('postgres://postgres:postgres@localhost:5432/wisp')
		expect(config.previewHost).toBe('wispsites.dev')
		expect(config.baseHost).toBe('wisp.place')
		expect(config.port).toBe(3004)
	})

	test('lowercases hosts and trims port', () => {
		const config = resolveConfig({ ...valid, PREVIEW_HOST: 'WispSites.Dev', BASE_HOST: 'Wisp.Place', PORT: ' 8080 ' })

		expect(config.previewHost).toBe('wispsites.dev')
		expect(config.baseHost).toBe('wisp.place')
		expect(config.port).toBe(8080)
	})

	test.each([
		['BOT_HANDLE', { BOT_HANDLE: '' }],
		['BOT_HANDLE', { BOT_HANDLE: 'not a handle' }],
		['BOT_PASSWORD', { BOT_PASSWORD: '' }],
		['DATABASE_URL', { DATABASE_URL: 'http://not-postgres' }],
		['PREVIEW_HOST', { PREVIEW_HOST: 'https://host' }],
		['PREVIEW_HOST', { PREVIEW_HOST: 'host:8080' }],
		['PREVIEW_HOST', { PREVIEW_HOST: '' }],
		['PORT', { PORT: '0' }],
		['PORT', { PORT: '70000' }],
		['PORT', { PORT: 'abc' }],
	] as Array<[string, Record<string, string>]>)('rejects invalid %s', (_name, patch) => {
		expect(() => resolveConfig({ ...valid, ...patch })).toThrow()
	})
})
