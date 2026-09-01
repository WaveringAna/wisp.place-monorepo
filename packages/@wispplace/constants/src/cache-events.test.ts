import { describe, expect, test } from 'bun:test'
import {
	DEFAULT_CACHE_INVALIDATION_CHANNEL,
	DEFAULT_CACHE_INVALIDATION_STREAM,
	DEFAULT_CACHE_INVALIDATION_STREAM_MAX_LEN,
	decodeCacheInvalidationMessage,
	encodeCacheInvalidationMessage,
	publishCacheInvalidationEvent,
	resolveCacheInvalidationStreamMaxLen,
} from './cache-events'

describe('cache invalidation wire contract', () => {
	test('keeps shared defaults stable', () => {
		expect(DEFAULT_CACHE_INVALIDATION_CHANNEL).toBe('wisp:cache-invalidate')
		expect(DEFAULT_CACHE_INVALIDATION_STREAM).toBe('wisp:cache-invalidate-stream')
		expect(DEFAULT_CACHE_INVALIDATION_STREAM_MAX_LEN).toBe(10_000)
	})

	test('decodes legacy payloads without dropping unknown keys', () => {
		expect(
			decodeCacheInvalidationMessage(
				JSON.stringify({
					did: 'did:plc:test',
					rkey: 'site',
					action: 'update',
					token: 'token-a',
					streamId: '1713811200000-2',
					legacyHint: 'kept',
				}),
			),
		).toMatchObject({
			did: 'did:plc:test',
			rkey: 'site',
			action: 'update',
			token: 'token-a',
			streamId: '1713811200000-2',
			legacyHint: 'kept',
		})
		expect(
			decodeCacheInvalidationMessage(
				JSON.stringify({ did: 'did:plc:test', rkey: 'site', action: 'update', token: 4, domainKind: 'unknown' }),
			),
		).toMatchObject({ did: 'did:plc:test', rkey: 'site', action: 'update', token: undefined, domainKind: undefined })
		expect(decodeCacheInvalidationMessage(JSON.stringify({ action: 'domain', domain: 'example.com' }))).toMatchObject({
			action: 'domain',
			domain: 'example.com',
			domainKind: undefined,
		})
	})

	test('rejects malformed JSON and missing required identifiers', () => {
		expect(decodeCacheInvalidationMessage('{')).toBeNull()
		expect(decodeCacheInvalidationMessage(JSON.stringify({ action: 'unknown' }))).toBeNull()
		expect(decodeCacheInvalidationMessage(JSON.stringify({ action: 'update', did: 'did:plc:test' }))).toBeNull()
		expect(decodeCacheInvalidationMessage(JSON.stringify({ action: 'domain', domainKind: 'wisp' }))).toBeNull()
	})

	test('preserves old field layouts and XADD-before-PUBLISH ordering', async () => {
		const site = { did: 'did:plc:test', rkey: 'site', action: 'update' as const, token: 'token-a' }
		expect(encodeCacheInvalidationMessage({ ...site, streamId: '1-0' })).toBe(
			'{"did":"did:plc:test","rkey":"site","action":"update","token":"token-a","streamId":"1-0"}',
		)
		const calls: string[] = []
		const redis = {
			xadd: async (stream: string, ...args: string[]) => {
				calls.push(`xadd:${stream}:${args.join('|')}`)
				return '1713811200000-2'
			},
			publish: async (channel: string, message: string) => calls.push(`publish:${channel}:${message}`),
		}
		await publishCacheInvalidationEvent(
			redis,
			{ did: 'did:plc:test', rkey: 'site', action: 'update' },
			DEFAULT_CACHE_INVALIDATION_CHANNEL,
			DEFAULT_CACHE_INVALIDATION_STREAM,
			10_000,
		)
		expect(calls[0]).toMatch(
			/^xadd:wisp:cache-invalidate-stream:MAXLEN\|~\|10000\|\*\|did\|did:plc:test\|rkey\|site\|action\|update\|ts\|\d+$/,
		)
		expect(calls[1]).toContain(
			'publish:wisp:cache-invalidate:{"did":"did:plc:test","rkey":"site","action":"update","streamId":"1713811200000-2"}',
		)
		calls.length = 0
		await publishCacheInvalidationEvent(
			redis,
			{ action: 'domain', domain: 'example.com', domainKind: 'custom', customDomainId: 'abc' },
			DEFAULT_CACHE_INVALIDATION_CHANNEL,
			DEFAULT_CACHE_INVALIDATION_STREAM,
			10_000,
		)
		expect(calls[0]).toContain(
			'xadd:wisp:cache-invalidate-stream:MAXLEN|~|10000|*|action|domain|domain|example.com|domainKind|custom|customDomainId|abc|ts|',
		)
	})

	test('uses a bounded MAXLEN fallback', () => {
		expect(resolveCacheInvalidationStreamMaxLen(undefined)).toBe(10_000)
		expect(resolveCacheInvalidationStreamMaxLen('25000')).toBe(25_000)
		expect(resolveCacheInvalidationStreamMaxLen('0')).toBe(10_000)
		expect(resolveCacheInvalidationStreamMaxLen('1000001')).toBe(10_000)
		expect(resolveCacheInvalidationStreamMaxLen('12junk')).toBe(10_000)
	})
})
