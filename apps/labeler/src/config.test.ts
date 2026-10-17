import { describe, expect, test } from 'bun:test'
import { resolveLabelerConfig } from './config'

const BASE = {
	LABELER_DID: 'did:plc:25fzqofm2xkx27bcaicxbyxk',
	LABELER_SIGNING_KEY: 'a'.repeat(64),
	LABELER_ADMIN_TOKEN: 'x'.repeat(32),
	DATABASE_URL: 'postgres://localhost/wisp',
}

describe('moderation config', () => {
	test('is off without a public URL', () => {
		expect(resolveLabelerConfig(BASE).moderation).toBeNull()
	})

	test('needs an https origin and at least one moderator', () => {
		expect(() => resolveLabelerConfig({ ...BASE, MODERATION_PUBLIC_URL: 'http://moderation.test' })).toThrow('https')
		expect(() => resolveLabelerConfig({ ...BASE, MODERATION_PUBLIC_URL: 'https://moderation.test' })).toThrow(
			'MODERATOR_DIDS',
		)
	})

	test('reads moderators, the briefing token and the model', () => {
		const config = resolveLabelerConfig({
			...BASE,
			MODERATION_PUBLIC_URL: 'https://moderation.test/',
			MODERATOR_DIDS: 'did:plc:a, did:plc:b',
			MODERATION_API_TOKEN: 't'.repeat(40),
			TRIAGE_URL: 'http://10.88.0.10:8899/',
		}).moderation
		expect(config).toEqual({
			publicUrl: 'https://moderation.test',
			moderators: ['did:plc:a', 'did:plc:b'],
			apiToken: 't'.repeat(40),
			triageUrl: 'http://10.88.0.10:8899',
			triageModel: 'bonsai-2-27b',
			syncIntervalMs: 30_000,
		})
		expect(() =>
			resolveLabelerConfig({
				...BASE,
				MODERATION_PUBLIC_URL: 'https://m.test',
				MODERATOR_DIDS: 'did:plc:a',
				MODERATION_API_TOKEN: 'short',
			}),
		).toThrow('MODERATION_API_TOKEN')
	})
})
