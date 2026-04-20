import { beforeEach, describe, expect, test } from 'bun:test'
import {
	clearSiteUpdating,
	isSiteUpdating,
	markSiteUpdating,
	parseCacheInvalidationMessage,
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
})
