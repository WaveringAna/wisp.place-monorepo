import { describe, expect, mock, test } from 'bun:test'

mock.module('./oauth-client', () => ({
	OAUTH_SCOPE: 'atproto include:place.wisp.authSites',
	OAUTH_LEGACY_SCOPE: 'atproto repo:place.wisp.fs',
	recentGrantedScope: (did: string) =>
		did === 'did:plc:granted'
			? 'atproto rpc:sh.tangled.repo.addSecret?aud=* rpc:sh.tangled.repo.listSecrets?aud=*'
			: 'atproto repo:place.wisp.fs',
}))

const { authorizeWisp, authorizeWispLegacy, canSetSpindleSecrets, ciSetupState, isCiSetupState } = await import(
	'./oauth-authorize'
)

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
		await authorizeWisp(client, 'did:plc:alice', { state: ciSetupState() })
		expect(requests[0]?.scope).toBe(
			'atproto include:place.wisp.authSites rpc:sh.tangled.repo.addSecret?aud=* rpc:sh.tangled.repo.listSecrets?aud=*',
		)
	})

	test('keeps asking for them when the granular fallback runs', async () => {
		const { client, requests } = recordingClient()
		await authorizeWispLegacy(client, 'did:plc:alice', ciSetupState())
		expect(requests[0]?.scope).toContain('rpc:sh.tangled.repo.addSecret?aud=*')
		expect(isCiSetupState(requests[0]?.state)).toBe(true)
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
