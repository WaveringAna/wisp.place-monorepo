import { describe, expect, it } from 'bun:test'
import { evaluateAccess } from './access-policy'
import { generateShareToken, hashShareTokenSync } from './token'
import type { PrivateSite, PrivateSiteShare } from './types'

const NOW = new Date('2026-07-24T12:00:00.000Z')
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000)

const OWNER = 'did:plc:owneraaaaaaaaaaaaaaaaaaaa'
const OTHER = 'did:plc:otherbbbbbbbbbbbbbbbbbbbb'

const site = (over: Partial<PrivateSite> = {}): PrivateSite => ({
	siteId: 'lovable-plushie-dog-1226',
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
	siteId: 'lovable-plushie-dog-1226',
	tokenHash,
	tokenPrefix: 'wss_1234',
	label: null,
	audienceDid: null,
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

/**
 * DID-scoped shares: a grant to a person rather than to whoever holds the link.
 *
 * This is the v1 form of an atproto permission grant, so these tests pin the behaviour
 * that has to survive the v2 migration onto proposal 0016 member lists.
 */
describe('DID-scoped shares', () => {
	const TOKEN = 'wss_scoped-token'
	const HASH = hashShareTokenSync(TOKEN)
	const scoped = share(HASH, { audienceDid: OTHER })

	it('admits the DID the share was issued to', () => {
		const decision = evaluateAccess({
			site: site(),
			shares: [scoped],
			principal: { kind: 'shareToken', token: TOKEN, viewerDid: OTHER },
			now: NOW,
		})
		expect(decision.allowed).toBe(true)
	})

	/**
	 * The link alone is not enough. This is the whole point of scoping: forwarding the URL
	 * to someone else does not forward the access.
	 */
	it('refuses a signed-out visitor holding a valid link', () => {
		const decision = evaluateAccess({
			site: site(),
			shares: [scoped],
			principal: { kind: 'shareToken', token: TOKEN, viewerDid: null },
			now: NOW,
		})
		expect(decision.allowed).toBe(false)
		expect(decision.reason).toBe('audienceMismatch')
	})

	it('refuses a different signed-in account', () => {
		const decision = evaluateAccess({
			site: site(),
			shares: [scoped],
			principal: { kind: 'shareToken', token: TOKEN, viewerDid: 'did:plc:someoneelseaaaaaaaaaaaa' },
			now: NOW,
		})
		expect(decision.allowed).toBe(false)
		expect(decision.reason).toBe('audienceMismatch')
	})

	/**
	 * `audienceMismatch` is reported instead of `forbidden` so the route layer can offer
	 * sign-in. It must only ever reach someone who already presented a valid token.
	 */
	it('reports a bad token as forbidden, never as audienceMismatch', () => {
		const decision = evaluateAccess({
			site: site(),
			shares: [scoped],
			principal: { kind: 'shareToken', token: 'wss_wrong', viewerDid: null },
			now: NOW,
		})
		expect(decision.reason).toBe('forbidden')
	})

	it('names the expected DID so the caller can say who the link was for', () => {
		const decision = evaluateAccess({
			site: site(),
			shares: [scoped],
			principal: { kind: 'shareToken', token: TOKEN, viewerDid: null },
			now: NOW,
		})
		expect(decision.allowed === false && decision.reason === 'audienceMismatch' && decision.audienceDid).toBe(OTHER)
	})

	/** Revocation and expiry still win: scoping adds a condition, it does not remove any. */
	it('still refuses a revoked scoped share for the right DID', () => {
		const decision = evaluateAccess({
			site: site(),
			shares: [share(HASH, { audienceDid: OTHER, revokedAt: NOW })],
			principal: { kind: 'shareToken', token: TOKEN, viewerDid: OTHER },
			now: NOW,
		})
		expect(decision.allowed).toBe(false)
		expect(decision.reason).toBe('shareRevoked')
	})

	/** An unscoped share keeps working for anyone, including signed-out visitors. */
	it('leaves bearer shares unscoped', () => {
		const decision = evaluateAccess({
			site: site(),
			shares: [share(HASH)],
			principal: { kind: 'shareToken', token: TOKEN, viewerDid: null },
			now: NOW,
		})
		expect(decision.allowed).toBe(true)
	})
})
