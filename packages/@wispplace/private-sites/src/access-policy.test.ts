import { describe, expect, it } from 'bun:test'
import { evaluateAccess } from './access-policy'
import { hashShareTokenSync } from './token'
import type { AccessPrincipal, PrivateSite, PrivateSiteShare } from './types'

const NOW = new Date('2026-07-24T12:00:00Z')
const OWNER = 'did:plc:owner'
const OTHER = 'did:plc:other'
const TOKEN = 'wss_valid'
const site = (values: Partial<PrivateSite> = {}): PrivateSite => ({
	siteId: 'bright-brook-fox-1234',
	state: 'ready',
	ownerDid: OWNER,
	name: 'secret plans',
	fileCount: 1,
	totalBytes: 10,
	expiresAt: null,
	createdAt: NOW,
	updatedAt: NOW,
	...values,
})
const share = (values: Partial<PrivateSiteShare> = {}): PrivateSiteShare => ({
	shareId: 'share-1',
	siteId: 'bright-brook-fox-1234',
	tokenHash: hashShareTokenSync(TOKEN),
	tokenPrefix: 'wss_va',
	label: null,
	audienceDid: null,
	expiresAt: null,
	revokedAt: null,
	createdAt: NOW,
	lastUsedAt: null,
	...values,
})

const decide = (principal: AccessPrincipal, values: { site?: PrivateSite | null; shares?: PrivateSiteShare[] } = {}) =>
	evaluateAccess({
		site: values.site === undefined ? site() : values.site,
		shares: values.shares ?? [],
		principal,
		now: NOW,
	})

describe('evaluateAccess', () => {
	it.each([
		['owner', { kind: 'owner', did: OWNER } as const, {}, { allowed: true, reason: 'owner' }],
		['other owner', { kind: 'owner', did: OTHER } as const, {}, { allowed: false, reason: 'forbidden' }],
		['anonymous', { kind: 'anonymous' } as const, {}, { allowed: false, reason: 'forbidden' }],
		['missing site', { kind: 'anonymous' } as const, { site: null }, { allowed: false, reason: 'notFound' }],
		[
			'expired owner',
			{ kind: 'owner', did: OWNER } as const,
			{ site: site({ expiresAt: new Date(NOW.getTime() - 1) }) },
			{ allowed: false, reason: 'siteExpired' },
		],
		[
			'live session',
			{ kind: 'sessionShare', shareId: 'share-1' } as const,
			{},
			{ allowed: true, reason: 'share', shareId: 'share-1' },
		],
	])('%s', (_name, principal, values, expected) => expect(decide(principal, values) as unknown).toEqual(expected))

	it.each([
		[
			'valid',
			share(),
			{ kind: 'shareToken', token: TOKEN } as const,
			{ allowed: true, reason: 'share', shareId: 'share-1' },
		],
		[
			'wrong token',
			share(),
			{ kind: 'shareToken', token: 'wss_wrong' } as const,
			{ allowed: false, reason: 'forbidden' },
		],
		[
			'wrong site',
			share({ siteId: 'other' }),
			{ kind: 'shareToken', token: TOKEN } as const,
			{ allowed: false, reason: 'forbidden' },
		],
		[
			'revoked',
			share({ revokedAt: NOW }),
			{ kind: 'shareToken', token: TOKEN } as const,
			{ allowed: false, reason: 'shareRevoked' },
		],
		[
			'expired',
			share({ expiresAt: NOW }),
			{ kind: 'shareToken', token: TOKEN } as const,
			{ allowed: false, reason: 'shareExpired' },
		],
	])('%s share', (_name, candidate, principal, expected) =>
		expect(decide(principal, { shares: [candidate] }) as unknown).toEqual(expected))

	it('hides staging and deleting rows from every principal', () => {
		for (const state of ['staging', 'deleting'] as const) {
			for (const principal of [
				{ kind: 'owner', did: OWNER } as const,
				{ kind: 'sessionShare', shareId: 'share-1' } as const,
				{ kind: 'shareToken', token: TOKEN } as const,
			]) {
				expect(decide(principal, { site: site({ state }), shares: [share()] })).toEqual({
					allowed: false,
					reason: 'notFound',
				})
			}
		}
	})

	it('closes shares and share sessions when the site expires', () => {
		const expired = site({ expiresAt: NOW })
		expect(decide({ kind: 'shareToken', token: TOKEN }, { site: expired, shares: [share()] }).reason).toBe(
			'siteExpired',
		)
		expect(decide({ kind: 'sessionShare', shareId: 'share-1' }, { site: expired }).reason).toBe('siteExpired')
	})

	it('requires the matching account for scoped shares without revealing bad tokens', () => {
		const scoped = share({ audienceDid: OTHER })
		expect(decide({ kind: 'shareToken', token: TOKEN, viewerDid: OTHER }, { shares: [scoped] }).allowed).toBe(true)
		expect(decide({ kind: 'shareToken', token: TOKEN }, { shares: [scoped] })).toEqual({
			allowed: false,
			reason: 'audienceMismatch',
			audienceDid: OTHER,
		})
		expect(decide({ kind: 'shareToken', token: 'wss_wrong' }, { shares: [scoped] }).reason).toBe('forbidden')
	})
})
