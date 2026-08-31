import { describe, expect, test } from 'bun:test'
import { parseConfig } from './config'
import {
	MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS,
	MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES,
	MAX_JETSTREAM_WANTED_DIDS,
} from './lib/admission'

const databaseUrl = 'postgres://user:password@db.example:5432/wisp'

function production(overrides: Record<string, string | undefined> = {}) {
	return { NODE_ENV: 'production', DATABASE_URL: databaseUrl, ...overrides }
}

describe('webhook service config', () => {
	test('treats unknown runtime as production-safe and requires a database URL', () => {
		expect(() => parseConfig({ NODE_ENV: 'staging' })).toThrow('DATABASE_URL')
		expect(() => parseConfig({ DATABASE_URL: databaseUrl, JETSTREAM_URL: 'ws://relay.example/subscribe' })).toThrow(
			'wss',
		)
	})

	test('allows insecure websocket only with explicit development opt-in and loopback', () => {
		expect(() =>
			parseConfig({ NODE_ENV: 'development', DATABASE_URL: databaseUrl, JETSTREAM_URL: 'ws://127.0.0.1/subscribe' }),
		).toThrow('wss')
		expect(
			parseConfig({
				NODE_ENV: 'development',
				WEBHOOK_ALLOW_INSECURE_DEV: '1',
				DATABASE_URL: databaseUrl,
				JETSTREAM_URL: 'ws://127.0.0.1/subscribe',
			}),
		).toMatchObject({ allowInsecureDevelopment: true })
	})

	test('rejects URL credentials/query injection, invalid interface, and loose integers', () => {
		expect(() => parseConfig(production({ JETSTREAM_URL: 'wss://user:pass@relay.example/subscribe' }))).toThrow(
			'credentials',
		)
		expect(() => parseConfig(production({ JETSTREAM_URL: 'wss://relay.example/subscribe?cursor=9' }))).toThrow('query')
		expect(() => parseConfig(production({ HEALTH_HOST: 'eth0' }))).toThrow('HEALTH_HOST')
		expect(() => parseConfig(production({ HEALTH_PORT: '3003oops' }))).toThrow('HEALTH_PORT')
	})
	test('shares the active-subscription admission ceiling with delivery fanout', () => {
		expect(parseConfig(production()).registryActiveSubscriptionsMax).toBe(MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS)
		expect(() =>
			parseConfig(production({ REGISTRY_ACTIVE_SUBSCRIPTIONS_MAX: String(MAX_ACTIVE_WEBHOOK_SUBSCRIPTIONS + 1) })),
		).toThrow('REGISTRY_ACTIVE_SUBSCRIPTIONS_MAX')
	})

	test('rejects configured direct subscription limits above Jetstream hard limits', () => {
		expect(() =>
			parseConfig(production({ REGISTRY_DIRECT_SCOPE_DIDS_MAX: String(MAX_JETSTREAM_WANTED_DIDS + 1) })),
		).toThrow('REGISTRY_DIRECT_SCOPE_DIDS_MAX')
		expect(() =>
			parseConfig(
				production({ REGISTRY_SUBSCRIPTION_URL_BYTES_MAX: String(MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES + 1) }),
			),
		).toThrow('REGISTRY_SUBSCRIPTION_URL_BYTES_MAX')
	})
})
