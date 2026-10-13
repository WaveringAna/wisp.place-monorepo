import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { OAuthSession } from '@atproto/oauth-client-node'
import { forgetGrantedScope, rememberGrantedScope } from './granted-scopes'
import {
	authorizeWisp,
	authorizeWispLegacy,
	canSetSpindleSecrets,
	grantedAddOns,
	setupAddOn,
	setupState,
	stateValue,
} from './oauth-authorize'
import { OAUTH_SCOPE } from './oauth-client-metadata'

const grants = {
	'did:plc:granted': 'atproto rpc:sh.tangled.repo.addSecret?aud=* rpc:sh.tangled.repo.listSecrets?aud=*',
	'did:plc:marque': 'atproto repo:place.wisp.fs repo:at.marque.dns?action=create&action=update',
	'did:plc:marque-update-only': 'atproto repo:at.marque.dns?action=update',
}

// Sessions this process just stored, as oauth-client records them. Any other
// DID falls back to asking its session, which holds an ordinary grant.
beforeAll(() => {
	for (const [did, scope] of Object.entries(grants)) rememberGrantedScope(did, scope)
})
afterAll(() => {
	for (const did of Object.keys(grants)) forgetGrantedScope(did)
})

const session = (did: string) =>
	({ did, getTokenInfo: async () => ({ scope: 'atproto repo:place.wisp.fs' }) }) as unknown as OAuthSession

const recordingClient = () => {
	const requests: { scope?: string; state?: string }[] = []
	const client = {
		authorize: async (_identifier: string, options: { scope?: string; state?: string }) => {
			requests.push(options)
			return new URL('https://pds.example/authorize')
		},
	}
	return { client: client as never, requests }
}

describe('connecting tangled CI', () => {
	test('asks for the spindle secret methods on top of the usual scope', async () => {
		const { client, requests } = recordingClient()
		await authorizeWisp(client, 'did:plc:alice', { state: setupState('ci', []) })
		expect(requests[0]?.scope).toBe(
			`${OAUTH_SCOPE} rpc:sh.tangled.repo.addSecret?aud=* rpc:sh.tangled.repo.listSecrets?aud=*`,
		)
	})

	test('keeps asking for them when the granular fallback runs', async () => {
		const { client, requests } = recordingClient()
		await authorizeWispLegacy(client, 'did:plc:alice', setupState('ci', []))
		expect(requests[0]?.scope).toContain('rpc:sh.tangled.repo.addSecret?aud=*')
		expect(setupAddOn(requests[0]?.state)).toBe('ci')
	})

	test('leaves an ordinary sign-in alone', async () => {
		const { client, requests } = recordingClient()
		await authorizeWisp(client, 'alice.example', { state: crypto.randomUUID() })
		expect(requests[0]?.scope).toBe(`${OAUTH_SCOPE}`)
	})

	test('reads the grant to decide whether secrets can be set', async () => {
		expect(await canSetSpindleSecrets(session('did:plc:granted'))).toBe(true)
		expect(await canSetSpindleSecrets(session('did:plc:other'))).toBe(false)
	})
})

describe('letting wisp edit marque dns', () => {
	test('asks for the zone record on top of the usual scope', async () => {
		const { client, requests } = recordingClient()
		await authorizeWisp(client, 'did:plc:alice', { state: setupState('marque', []) })
		expect(requests[0]?.scope).toBe(`${OAUTH_SCOPE} repo:at.marque.dns?action=create&action=update`)
	})

	test('keeps the add-ons the session already holds, since the new grant replaces it', async () => {
		const { client, requests } = recordingClient()
		await authorizeWisp(client, 'did:plc:alice', { state: setupState('marque', ['ci']) })
		expect(requests[0]?.scope).toBe(
			`${OAUTH_SCOPE} rpc:sh.tangled.repo.addSecret?aud=* rpc:sh.tangled.repo.listSecrets?aud=* repo:at.marque.dns?action=create&action=update`,
		)
		expect(setupAddOn(requests[0]?.state)).toBe('marque')
	})

	test('carries the domain to reopen through the sign-in', () => {
		expect(stateValue(setupState('marque', [], { domain: 'abc123' }), 'domain')).toBe('abc123')
	})

	test('reads which add-ons a grant holds', async () => {
		expect(await grantedAddOns(session('did:plc:marque'))).toEqual(['marque'])
		expect(await grantedAddOns(session('did:plc:granted'))).toEqual(['ci'])
		expect(await grantedAddOns(session('did:plc:other'))).toEqual([])
		// putRecord needs create as well, so a grant from before that was known asks again.
		expect(await grantedAddOns(session('did:plc:marque-update-only'))).toEqual([])
	})

	test('ignores state that names no add-on', () => {
		expect(setupAddOn(JSON.stringify({ wispSetup: 'everything' }))).toBeNull()
		expect(setupAddOn(crypto.randomUUID())).toBeNull()
	})
})
