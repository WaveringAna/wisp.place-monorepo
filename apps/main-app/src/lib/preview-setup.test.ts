import { describe, expect, test } from 'bun:test'
import { disablePreview, enablePreview, loadPreviews, type PreviewSetupPorts } from './preview-setup'
import type { PreviewHook, TangledRepo } from './previews'

const repo = (name: string, extra: Partial<TangledRepo> = {}): TangledRepo => ({
	rkey: name,
	name,
	spindle: 'spindle.tangled.sh',
	repoDid: 'did:plc:kya7uhnwkpq7zfngkebpxl6i',
	knot: 'knot1.tangled.sh',
	...extra,
})

function fakePorts(overrides: Partial<PreviewSetupPorts> = {}) {
	const calls: string[] = []
	const ports: PreviewSetupPorts = {
		listRepos: async () => [repo('blog'), repo('notes', { spindle: undefined })],
		listHooks: async () => [],
		claims: async () => ['alice'],
		canSetSecrets: async () => true,
		hasSecret: async () => false,
		checkAppPassword: async () => true,
		setSecret: async (target) => {
			calls.push(`secret ${target.name}`)
		},
		putHook: async (target, claim) => {
			calls.push(`hook ${target.name} ${claim}`)
		},
		deleteHook: async (rkey) => {
			calls.push(`delete ${rkey}`)
		},
		...overrides,
	}
	return { ports, calls }
}

describe('loadPreviews', () => {
	test('lists repos with their preview state, claims, and whether secrets can be set', async () => {
		const hooks: PreviewHook[] = [{ rkey: 'preview-blog', repo: 'blog', claim: 'alice' }]
		const { ports } = fakePorts({ listHooks: async () => hooks, hasSecret: async (target) => target.name === 'blog' })
		const view = await loadPreviews(ports)
		expect(view.claims).toEqual(['alice'])
		expect(view.canSetSecrets).toBe(true)
		expect(view.repos.map((row) => [row.name, row.preview?.claim ?? null, row.blocked, row.secret])).toEqual([
			['blog', 'alice', null, 'set'],
			['notes', null, 'no-spindle', 'unknown'],
		])
	})

	test('does not ask spindles about secrets it may not read', async () => {
		let asked = false
		const { ports } = fakePorts({
			canSetSecrets: async () => false,
			hasSecret: async () => {
				asked = true
				return true
			},
		})
		const view = await loadPreviews(ports)
		expect(asked).toBe(false)
		expect(view.repos.every((row) => row.secret === 'unknown')).toBe(true)
	})

	test('treats a spindle that will not answer as unknown rather than failing the page', async () => {
		const { ports } = fakePorts({
			hasSecret: async () => {
				throw new Error('down')
			},
		})
		expect((await loadPreviews(ports)).repos[0]?.secret).toBe('unknown')
	})
})

describe('enablePreview', () => {
	test('stores the deploy secret before creating the hook', async () => {
		const { ports, calls } = fakePorts()
		expect(await enablePreview(ports, { repo: 'blog', claim: 'alice', appPassword: 'abcd-efgh-ijkl-mnop' })).toEqual({
			ok: true,
		})
		expect(calls).toEqual(['secret blog', 'hook blog alice'])
	})

	test('creates only the hook when no password is given', async () => {
		const { ports, calls } = fakePorts()
		expect(await enablePreview(ports, { repo: 'blog', claim: 'alice' })).toEqual({ ok: true })
		expect(calls).toEqual(['hook blog alice'])
	})

	test.each([
		['unknown-repo', { repo: 'missing', claim: 'alice' }, {}],
		['no-spindle', { repo: 'notes', claim: 'alice' }, {}],
		['claim-not-owned', { repo: 'blog', claim: 'bob' }, {}],
		['needs-ci-permission', { repo: 'blog', claim: 'alice', appPassword: 'pw' }, { canSetSecrets: async () => false }],
		['bad-app-password', { repo: 'blog', claim: 'alice', appPassword: 'pw' }, { checkAppPassword: async () => false }],
	] as const)('refuses with %s and changes nothing', async (reason, input, overrides) => {
		const { ports, calls } = fakePorts(overrides as Partial<PreviewSetupPorts>)
		expect(await enablePreview(ports, input)).toEqual({ ok: false, reason })
		expect(calls).toEqual([])
	})

	test('leaves no hook behind when the spindle refuses the secret', async () => {
		const { ports, calls } = fakePorts({
			setSecret: async () => {
				throw new Error('spindle said no')
			},
		})
		expect(await enablePreview(ports, { repo: 'blog', claim: 'alice', appPassword: 'pw' })).toEqual({
			ok: false,
			reason: 'secret-failed',
		})
		expect(calls).toEqual([])
	})
})

describe('disablePreview', () => {
	test("deletes the repo's hook", async () => {
		const { ports, calls } = fakePorts({
			listHooks: async () => [{ rkey: 'preview-blog', repo: 'blog', claim: 'alice' }],
		})
		expect(await disablePreview(ports, 'blog')).toEqual({ ok: true })
		expect(calls).toEqual(['delete preview-blog'])
	})

	test('is a no-op for a repo that was never enabled', async () => {
		const { ports, calls } = fakePorts()
		expect(await disablePreview(ports, 'blog')).toEqual({ ok: true })
		expect(calls).toEqual([])
	})
})
