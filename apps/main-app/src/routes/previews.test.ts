import { describe, expect, mock, test } from 'bun:test'
import type { PreviewSetupPorts } from '../lib/preview-setup'

const DID = 'did:plc:3rwz3xfw2crswgifqgc3g7zh'

mock.module('../lib/db', () => ({
	consumeWebhookMutationRateLimit: async () => true,
	eventualRead: { getDomainsForDid: async () => ({ wispDomains: [], customDomains: [] }) },
	withWebhookOwnerMutationLock: async (_did: string, run: () => Promise<unknown>) => run(),
}))

mock.module('../lib/oauth-authorize', () => ({
	canSetSpindleSecrets: async () => false,
}))

mock.module('../lib/wisp-auth', () => ({
	SESSION_COOKIE_NAME: 'did',
	requireAuth: async () => ({ did: DID, session: {} }),
}))

const { previewRoutes } = await import('./previews')

function fakePorts(overrides: Partial<PreviewSetupPorts> = {}) {
	const calls: string[] = []
	const ports: PreviewSetupPorts = {
		listRepos: async () => [
			{
				rkey: 'blog',
				name: 'blog',
				spindle: 'spindle.tangled.sh',
				repoDid: 'did:plc:kya7uhnwkpq7zfngkebpxl6i',
				knot: undefined,
			},
		],
		listHooks: async () => [],
		claims: async () => ['alice'],
		canSetSecrets: async () => false,
		hasSecret: async () => false,
		checkAppPassword: async () => true,
		setSecret: async () => {
			calls.push('secret')
		},
		putHook: async (repo, claim) => {
			calls.push(`hook ${repo.name} ${claim}`)
		},
		deleteHook: async (rkey) => {
			calls.push(`delete ${rkey}`)
		},
		...overrides,
	}
	return { ports, calls }
}

const app = (ports: PreviewSetupPorts) => previewRoutes({} as never, 'test-cookie-secret', () => ports)
const put = (path: string, body: unknown) =>
	new Request(`http://localhost/api/previews/${path}`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	})

describe('preview routes', () => {
	test('lists repos with what the dashboard needs to set them up', async () => {
		const { ports } = fakePorts()
		const response = await app(ports).handle(new Request('http://localhost/api/previews/'))
		expect(response.status).toBe(200)
		const body = (await response.json()) as {
			repos: { name: string; secret: string }[]
			claims: string[]
			canSetSecrets: boolean
		}
		expect(body.claims).toEqual(['alice'])
		expect(body.canSetSecrets).toBe(false)
		expect(body.repos.map((row) => [row.name, row.secret])).toEqual([['blog', 'unknown']])
	})

	test('enables previews for a repo', async () => {
		const { ports, calls } = fakePorts()
		const response = await app(ports).handle(put('blog', { claim: 'alice' }))
		expect(response.status).toBe(200)
		expect(calls).toEqual(['hook blog alice'])
	})

	test('asks for the CI permission before taking an app password it cannot store', async () => {
		const { ports, calls } = fakePorts()
		const response = await app(ports).handle(put('blog', { claim: 'alice', appPassword: 'abcd-efgh-ijkl-mnop' }))
		expect(response.status).toBe(403)
		expect(await response.json()).toEqual({ success: false, error: 'needs-ci-permission' })
		expect(calls).toEqual([])
	})

	test('rejects malformed repo names and claims before reading anything', async () => {
		let read = false
		const { ports } = fakePorts({
			listRepos: async () => {
				read = true
				return []
			},
		})
		expect((await app(ports).handle(put('a%20b', { claim: 'alice' }))).status).toBe(400)
		expect((await app(ports).handle(put('blog', { claim: 'Not A Claim' }))).status).toBe(400)
		expect(read).toBe(false)
	})

	test('disables previews for a repo', async () => {
		const { ports, calls } = fakePorts({
			listHooks: async () => [{ rkey: 'preview-blog', repo: 'blog', claim: 'alice', owner: null }],
		})
		const response = await app(ports).handle(new Request('http://localhost/api/previews/blog', { method: 'DELETE' }))
		expect(response.status).toBe(200)
		expect(calls).toEqual(['delete preview-blog'])
	})

	test('answers an upstream failure with a generic error', async () => {
		const { ports } = fakePorts({
			listRepos: async () => {
				throw new Error('pds down: secret details')
			},
		})
		const response = await app(ports).handle(new Request('http://localhost/api/previews/'))
		expect(response.status).toBe(500)
		expect(await response.text()).not.toContain('secret details')
	})
})
