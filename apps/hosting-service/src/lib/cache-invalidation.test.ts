import { beforeEach, describe, expect, test } from 'bun:test'
import {
	clearSiteUpdating,
	compareStreamIds,
	getUpdatingSiteCountForTests,
	isSiteUpdating,
	markSiteUpdating,
	parseCacheInvalidationMessage,
	parseCacheInvalidationStreamEntry,
	resetUpdatingSitesForTests,
	withReplayReadTimeout,
} from './cache-invalidation'

const DID = 'did:plc:test'
const RKEY = 'site'

describe('cache invalidation updating state', () => {
	beforeEach(() => {
		resetUpdatingSitesForTests()
	})

	test('stale token cannot clear a newer update', () => {
		markSiteUpdating(DID, RKEY, 'token-a')
		markSiteUpdating(DID, RKEY, 'token-b')

		expect(clearSiteUpdating(DID, RKEY, 'token-a')).toBe(false)
		expect(isSiteUpdating(DID, RKEY)).toBe(true)
	})

	test('matching token clears the active update', () => {
		markSiteUpdating(DID, RKEY, 'token-a')

		expect(clearSiteUpdating(DID, RKEY, 'token-a')).toBe(true)
		expect(isSiteUpdating(DID, RKEY)).toBe(false)
	})

	test('unversioned clear remains backward compatible', () => {
		markSiteUpdating(DID, RKEY, 'token-a')

		expect(clearSiteUpdating(DID, RKEY)).toBe(true)
		expect(isSiteUpdating(DID, RKEY)).toBe(false)
	})

	test('marking a new site prunes expired updating entries that were never requested', () => {
		const originalNow = Date.now
		let now = 1_000_000
		Date.now = () => now

		try {
			markSiteUpdating(DID, 'expired-a')
			markSiteUpdating(DID, 'expired-b')

			now += 10 * 60 * 1000 + 1
			markSiteUpdating(DID, 'active')

			expect(getUpdatingSiteCountForTests()).toBe(1)
			expect(isSiteUpdating(DID, 'active')).toBe(true)
			expect(isSiteUpdating(DID, 'expired-a')).toBe(false)
			expect(isSiteUpdating(DID, 'expired-b')).toBe(false)
		} finally {
			Date.now = originalNow
		}
	})

	test('updating state is capped even when entries have not expired', () => {
		for (let i = 0; i < 10_005; i++) {
			markSiteUpdating(DID, `site-${i}`)
		}

		expect(getUpdatingSiteCountForTests()).toBe(10_000)
		expect(isSiteUpdating(DID, 'site-0')).toBe(false)
		expect(isSiteUpdating(DID, 'site-5')).toBe(true)
		expect(isSiteUpdating(DID, 'site-10004')).toBe(true)
	})

	test('message parsing preserves token', () => {
		expect(
			parseCacheInvalidationMessage(JSON.stringify({ did: DID, rkey: RKEY, action: 'update', token: 'token-a' })),
		).toEqual({
			did: DID,
			rkey: RKEY,
			action: 'update',
			token: 'token-a',
		})
	})

	test('message parsing preserves stream id', () => {
		expect(
			parseCacheInvalidationMessage(
				JSON.stringify({ did: DID, rkey: RKEY, action: 'update', token: 'token-a', streamId: '1713811200000-2' }),
			),
		).toEqual({
			did: DID,
			rkey: RKEY,
			action: 'update',
			token: 'token-a',
			streamId: '1713811200000-2',
		})
	})

	test('stream entry parsing reconstructs invalidation messages', () => {
		expect(
			parseCacheInvalidationStreamEntry('1713811200000-5', [
				'did',
				DID,
				'rkey',
				RKEY,
				'action',
				'updating',
				'token',
				'token-a',
				'ts',
				'1713811200000',
			]),
		).toEqual({
			did: DID,
			rkey: RKEY,
			action: 'updating',
			token: 'token-a',
			streamId: '1713811200000-5',
		})
	})

	test('domain invalidation message parsing preserves domain keys', () => {
		expect(
			parseCacheInvalidationMessage(
				JSON.stringify({
					action: 'domain',
					domain: 'example.wisp.place',
					domainKind: 'wisp',
					streamId: '1713811200000-6',
				}),
			),
		).toEqual({
			action: 'domain',
			domain: 'example.wisp.place',
			domainKind: 'wisp',
			streamId: '1713811200000-6',
		})
	})

	test('domain stream entry parsing reconstructs domain invalidation messages', () => {
		expect(
			parseCacheInvalidationStreamEntry('1713811200000-7', [
				'action',
				'domain',
				'domain',
				'example.com',
				'domainKind',
				'custom',
				'customDomainId',
				'abc123',
				'ts',
				'1713811200000',
			]),
		).toEqual({
			action: 'domain',
			domain: 'example.com',
			domainKind: 'custom',
			customDomainId: 'abc123',
			streamId: '1713811200000-7',
		})
	})

	test('stream ids sort by timestamp and sequence', () => {
		expect(compareStreamIds('1713811200000-1', '1713811200000-2')).toBeLessThan(0)
		expect(compareStreamIds('1713811200001-0', '1713811200000-999')).toBeGreaterThan(0)
		expect(compareStreamIds('1713811200001-3', '1713811200001-3')).toBe(0)
	})

	test('stalled replay reads time out so the client can reconnect', async () => {
		const stalledRead = new Promise<never>(() => {})
		await expect(withReplayReadTimeout(stalledRead, 5)).rejects.toThrow('Redis stream read exceeded')
	})
})
