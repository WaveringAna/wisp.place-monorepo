import { describe, expect, it } from 'bun:test'
import { evaluateAccess } from './access-policy'
import { generateShareToken } from './token'
import type { PrivateSite, PrivateSiteShare } from './types'

const NOW = new Date('2026-07-24T12:00:00.000Z')
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000)

const OWNER = 'did:plc:owneraaaaaaaaaaaaaaaaaaaa'
const OTHER = 'did:plc:otherbbbbbbbbbbbbbbbbbbbb'

const site = (over: Partial<PrivateSite> = {}): PrivateSite => ({
	siteId: 'abcdefghijklm',
	ownerDid: OWNER,
	name: 'secret plans',
	fileCount: 1,
	totalBytes: 10,
	expiresAt: null,
	createdAt: NOW,
	updatedAt: NOW,
	...over,
})

const share = (tokenHash: string, over: Partial<PrivateSiteShare> = {}): PrivateSiteShare => ({
	shareId: 'share-1',
	siteId: 'abcdefghijklm',
	tokenHash,
	tokenPrefix: 'wss_1234',
	label: null,
	expiresAt: null,
	revokedAt: null,
	createdAt: NOW,
	lastUsedAt: null,
	...over,
})

describe('evaluateAccess - owner', () => {
	it('allows the owner', () => {
		const d = evaluateAccess({ site: site(), shares: [], principal: { kind: 'owner', did: OWNER }, now: NOW })
		expect(d).toEqual({ allowed: true, reason: 'owner' })
	})

	it('denies a different authenticated account', () => {
		const d = evaluateAccess({ site: site(), shares: [], principal: { kind: 'owner', did: OTHER }, now: NOW })
		expect(d).toEqual({ allowed: false, reason: 'forbidden' })
	})

	it('still allows the owner after the site expired, so they can manage it', () => {
		const d = evaluateAccess({
			site: site({ expiresAt: minutes(-10) }),
			shares: [],
			principal: { kind: 'owner', did: OWNER },
			now: NOW,
		})
		expect(d).toEqual({ allowed: true, reason: 'owner' })
	})
})

describe('evaluateAccess - anonymous', () => {
	it('denies an anonymous visitor', () => {
		const d = evaluateAccess({ site: site(), shares: [], principal: { kind: 'anonymous' }, now: NOW })
		expect(d).toEqual({ allowed: false, reason: 'forbidden' })
	})

	it('reports notFound for a missing site', () => {
		const d = evaluateAccess({ site: null, shares: [], principal: { kind: 'anonymous' }, now: NOW })
		expect(d).toEqual({ allowed: false, reason: 'notFound' })
	})
})

describe('evaluateAccess - share tokens', () => {
	it('allows a valid share token', () => {
		const t = generateShareToken()
		const d = evaluateAccess({
			site: site(),
			shares: [share(t.tokenHash)],
			principal: { kind: 'shareToken', token: t.token },
			now: NOW,
		})
		expect(d).toEqual({ allowed: true, reason: 'share', shareId: 'share-1' })
	})

	it('denies a token that does not match', () => {
		const good = generateShareToken()
		const bad = generateShareToken()
		const d = evaluateAccess({
			site: site(),
			shares: [share(good.tokenHash)],
			principal: { kind: 'shareToken', token: bad.token },
			now: NOW,
		})
		expect(d).toEqual({ allowed: false, reason: 'forbidden' })
	})

	it('denies a revoked share', () => {
		const t = generateShareToken()
		const d = evaluateAccess({
			site: site(),
			shares: [share(t.tokenHash, { revokedAt: minutes(-1) })],
			principal: { kind: 'shareToken', token: t.token },
			now: NOW,
		})
		expect(d).toEqual({ allowed: false, reason: 'shareRevoked' })
	})

	it('denies an expired share', () => {
		const t = generateShareToken()
		const d = evaluateAccess({
			site: site(),
			shares: [share(t.tokenHash, { expiresAt: minutes(-1) })],
			principal: { kind: 'shareToken', token: t.token },
			now: NOW,
		})
		expect(d).toEqual({ allowed: false, reason: 'shareExpired' })
	})

	it('allows a share that has not yet expired', () => {
		const t = generateShareToken()
		const d = evaluateAccess({
			site: site(),
			shares: [share(t.tokenHash, { expiresAt: minutes(5) })],
			principal: { kind: 'shareToken', token: t.token },
			now: NOW,
		})
		expect(d.allowed).toBe(true)
	})

	it('denies every share once the site itself expired', () => {
		const t = generateShareToken()
		const d = evaluateAccess({
			site: site({ expiresAt: minutes(-1) }),
			shares: [share(t.tokenHash)],
			principal: { kind: 'shareToken', token: t.token },
			now: NOW,
		})
		expect(d).toEqual({ allowed: false, reason: 'siteExpired' })
	})

	it('ignores a valid token belonging to a different site', () => {
		const t = generateShareToken()
		const d = evaluateAccess({
			site: site(),
			shares: [share(t.tokenHash, { siteId: 'zzzzzzzzzzzzz' })],
			principal: { kind: 'shareToken', token: t.token },
			now: NOW,
		})
		expect(d).toEqual({ allowed: false, reason: 'forbidden' })
	})

	it('treats expiry as inclusive: exactly at expiry is expired', () => {
		const t = generateShareToken()
		const d = evaluateAccess({
			site: site(),
			shares: [share(t.tokenHash, { expiresAt: NOW })],
			principal: { kind: 'shareToken', token: t.token },
			now: NOW,
		})
		expect(d).toEqual({ allowed: false, reason: 'shareExpired' })
	})
})
