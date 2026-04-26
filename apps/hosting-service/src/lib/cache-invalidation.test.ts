import { beforeEach, describe, expect, test } from 'bun:test'
import {
	clearSiteUpdating,
	compareStreamIds,
	isSiteUpdating,
	markSiteUpdating,
	parseCacheInvalidationMessage,
	parseCacheInvalidationStreamEntry,
	resetUpdatingSitesForTests,
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
})
