import { beforeEach, describe, expect, test } from 'bun:test'
import { signCookie } from 'elysia/utils'
import { clearSessionCache } from '../lib/wisp-auth'
import { createDomainRoutes, type DomainRouteDeps } from './domain'

const COOKIE_SECRET = 'test-cookie-secret'
const OWNER = 'did:plc:owner'
const OTHER = 'did:plc:other'
const ID = '34eabdd5fdec1d1f'

const verificationWrites: Array<[string, boolean]> = []
const registrations = new Map<string, unknown>()

const fail = async (): Promise<never> => {
	throw new Error('unexpected database call')
}

const app = createDomainRoutes({
	claimCustomDomain: fail,
	claimDomain: fail,
	deleteCustomDomain: fail,
	deleteWispDomain: fail,
	getCustomDomainById: (async (id: string) =>
		id === ID ? { id, domain: 'victim.example', did: OWNER, verified: true } : null) as never,
	getCustomDomainInfo: fail,
	getDomainByDid: fail,
	isDomainAvailable: fail,
	isDomainRegistered: (async (domain: string) =>
		registrations.get(domain) ?? { registered: false }) as DomainRouteDeps['isDomainRegistered'],
	updateCustomDomainRkey: fail,
	updateCustomDomainVerification: (async (id: string, verified: boolean) => {
		verificationWrites.push([id, verified])
	}) as never,
	updateDomain: fail,
	updateWispDomainSite: fail,
	waitForSiteCache: fail,
	hasLivePrivateSite: async () => false,
})({ restore: async (did: string) => ({ did }) } as never, COOKIE_SECRET)

const verifyAs = async (did: string): Promise<Response> =>
	app.handle(
		new Request('http://localhost/api/domain/custom/verify', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', cookie: `did=${await signCookie(did, COOKIE_SECRET)}` },
			body: JSON.stringify({ id: ID }),
		}),
	)

beforeEach(() => {
	clearSessionCache()
	verificationWrites.length = 0
	registrations.clear()
})

describe('custom domain ownership', () => {
	test("another account cannot re-verify, and so un-verify, someone else's domain", async () => {
		const response = await verifyAs(OTHER)
		expect(response.status).toBe(403)
		expect(verificationWrites).toEqual([])
	})

	test('an unverified custom claim gets no certificate', async () => {
		const claim = { registered: true, type: 'custom', domain: 'claimed.example', did: OTHER, verified: false }
		registrations.set('claimed.example', claim)
		registrations.set('verified.example', { ...claim, domain: 'verified.example', verified: true })
		registrations.set('sub.wisp.place', { registered: true, type: 'wisp', domain: 'sub.wisp.place', did: OTHER })
		const ask = (domain: string) => app.handle(new Request(`http://localhost/api/domain/registered?domain=${domain}`))
		expect((await ask('claimed.example')).status).toBe(404)
		expect((await ask('verified.example')).status).toBe(200)
		expect((await ask('sub.wisp.place')).status).toBe(200)
	})
})
