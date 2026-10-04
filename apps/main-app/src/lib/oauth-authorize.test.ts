import { describe, expect, mock, test } from 'bun:test'

mock.module('./oauth-client', () => ({
	OAUTH_SCOPE: 'atproto include:place.wisp.authSites',
	OAUTH_LEGACY_SCOPE: 'atproto repo:place.wisp.fs',
	recentGrantedScope: (did: string) =>
		({
			'did:plc:granted': 'atproto rpc:sh.tangled.repo.addSecret?aud=* rpc:sh.tangled.repo.listSecrets?aud=*',
			'did:plc:marque': 'atproto repo:place.wisp.fs repo:at.marque.dns?action=update',
		})[did] ?? 'atproto repo:place.wisp.fs',
}))

const { authorizeWisp, authorizeWispLegacy, canSetSpindleSecrets, grantedAddOns, setupAddOn, setupState, stateValue } =
	await import('./oauth-authorize')

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
			'atproto include:place.wisp.authSites rpc:sh.tangled.repo.addSecret?aud=* rpc:sh.tangled.repo.listSecrets?aud=*',
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
		expect(requests[0]?.scope).toBe('atproto include:place.wisp.authSites')
	})

	test('reads the grant to decide whether secrets can be set', async () => {
		expect(await canSetSpindleSecrets({ did: 'did:plc:granted' } as never)).toBe(true)
		expect(await canSetSpindleSecrets({ did: 'did:plc:other' } as never)).toBe(false)
	})
})

describe('letting wisp edit marque dns', () => {
	test('asks for the zone record on top of the usual scope', async () => {
		const { client, requests } = recordingClient()
		await authorizeWisp(client, 'did:plc:alice', { state: setupState('marque', []) })
		expect(requests[0]?.scope).toBe('atproto include:place.wisp.authSites repo:at.marque.dns?action=update')
	})

	test('keeps the add-ons the session already holds, since the new grant replaces it', async () => {
		const { client, requests } = recordingClient()
		await authorizeWisp(client, 'did:plc:alice', { state: setupState('marque', ['ci']) })
		expect(requests[0]?.scope).toBe(
			'atproto include:place.wisp.authSites rpc:sh.tangled.repo.addSecret?aud=* rpc:sh.tangled.repo.listSecrets?aud=* repo:at.marque.dns?action=update',
		)
		expect(setupAddOn(requests[0]?.state)).toBe('marque')
	})

	test('carries the domain to reopen through the sign-in', () => {
		expect(stateValue(setupState('marque', [], { domain: 'abc123' }), 'domain')).toBe('abc123')
	})

	test('reads which add-ons a grant holds', async () => {
		expect(await grantedAddOns({ did: 'did:plc:marque' } as never)).toEqual(['marque'])
		expect(await grantedAddOns({ did: 'did:plc:granted' } as never)).toEqual(['ci'])
		expect(await grantedAddOns({ did: 'did:plc:other' } as never)).toEqual([])
	})

	test('ignores state that names no add-on', () => {
		expect(setupAddOn(JSON.stringify({ wispSetup: 'everything' }))).toBeNull()
		expect(setupAddOn(crypto.randomUUID())).toBeNull()
	})
})
