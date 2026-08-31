import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { PRIVATE_SHARE_QUERY_PARAM } from '@wispplace/constants'
import {
	hashSecret,
	hashShareTokenSync,
	PRIVATE_GRANT_QUERY_PARAM,
	type PrivateSite,
	sessionCookieName,
} from '@wispplace/private-sites'
import { Hono } from 'hono'
import type {
	AuthorizedPrivateSite,
	PrivateHandoffExchangeInput,
	PrivateHandoffExchangeResult,
	PrivateShareTokenExchangeInput,
	PrivateShareTokenExchangeResult,
} from './private-sites-db'

const SITE_ID = 'bright-brook-fox-1234'
const encoder = new TextEncoder()

const calls = {
	handoffs: [] as PrivateHandoffExchangeInput[],
	loads: [] as Array<{ siteId: string; secretHash: string }>,
	shares: [] as PrivateShareTokenExchangeInput[],
	storageKeys: [] as string[],
	touchedShares: [] as string[],
}

let exchangeHandoff: (input: PrivateHandoffExchangeInput) => Promise<PrivateHandoffExchangeResult | null>
let exchangeShare: (input: PrivateShareTokenExchangeInput) => Promise<PrivateShareTokenExchangeResult | null>
let loadAuthorized: (siteId: string, secretHash: string) => Promise<AuthorizedPrivateSite | null>
let readStorage: (key: string) => Promise<Uint8Array | null>
let touchGrantedShare: (shareId: string) => Promise<void>

mock.module('./private-sites-db', () => ({
	exchangePrivateHandoff: (input: PrivateHandoffExchangeInput) => {
		calls.handoffs.push(input)
		return exchangeHandoff(input)
	},
	exchangePrivateShareToken: (input: PrivateShareTokenExchangeInput) => {
		calls.shares.push(input)
		return exchangeShare(input)
	},
	loadAuthorizedPrivateSite: (siteId: string, secretHash: string) => {
		calls.loads.push({ siteId, secretHash })
		return loadAuthorized(siteId, secretHash)
	},
	touchShare: (shareId: string) => {
		calls.touchedShares.push(shareId)
		return touchGrantedShare(shareId)
	},
}))

mock.module('./storage', () => ({
	privateStorage: {
		get: (key: string) => {
			calls.storageKeys.push(key)
			return readStorage(key)
		},
	},
}))

const { privateNotFound, servePrivateSite } = await import('./private-serving')

const file = (path: string, mimeType: string | null = 'text/plain') => ({ path, size: 4, mimeType })
const readyAuthorized = (files: AuthorizedPrivateSite['files']): AuthorizedPrivateSite => ({
	site: {
		state: 'ready',
		siteId: SITE_ID,
		ownerDid: 'did:plc:owner',
		name: 'private-test',
		fileCount: files.length,
		totalBytes: files.reduce((total, current) => total + current.size, 0),
		expiresAt: null,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
	} satisfies PrivateSite,
	files,
})

const requestFor = (path = '', query = '', init: RequestInit = {}): Request => {
	return new Request(`https://${SITE_ID}.priv.wisp.place/${path}${query}`, init)
}

const secureCookie = (value: string): string => `${sessionCookieName(true)}=${value}`

const expectPrivateHeaders = (response: Response): void => {
	expect(response.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate, private')
	expect(response.headers.get('pragma')).toBe('no-cache')
	expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive, nosnippet')
}

const expectNotFound = async (response: Response): Promise<void> => {
	expect(response.status).toBe(404)
	expect(await response.text()).toBe('Not found')
	expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
	expectPrivateHeaders(response)
}

beforeEach(() => {
	calls.handoffs.length = 0
	calls.loads.length = 0
	calls.shares.length = 0
	calls.storageKeys.length = 0
	calls.touchedShares.length = 0
	exchangeHandoff = async () => null
	exchangeShare = async () => null
	loadAuthorized = async () => null
	readStorage = async () => null
	touchGrantedShare = async () => undefined
})

describe('private request validation and anonymous responses', () => {
	for (const scenario of [
		{ name: 'backslash traversal', path: '..\\secret.txt' },
		{ name: 'dot traversal', path: '../secret.txt' },
		{ name: 'absolute path', path: '/secret.txt' },
		{ name: 'duplicate separator', path: 'assets//secret.txt' },
		{ name: 'encoded traversal marker', path: '%2e%2e/secret.txt' },
		{ name: 'trailing slash', path: 'assets/' },
	]) {
		test(`rejects ${scenario.name} before authorization or storage`, async () => {
			const response = await servePrivateSite(requestFor(), SITE_ID, scenario.path)

			expect(response.status).toBe(400)
			expect(await response.text()).toBe('Invalid path')
			expectPrivateHeaders(response)
			expect(calls.handoffs).toHaveLength(0)
			expect(calls.shares).toHaveLength(0)
			expect(calls.loads).toHaveLength(0)
			expect(calls.storageKeys).toHaveLength(0)
		})
	}

	test('rejects an invalid site id with the generic private not-found response', async () => {
		const response = await servePrivateSite(requestFor(), 'not-a-private-site', 'index.html')

		await expectNotFound(response)
		expect(calls.handoffs).toHaveLength(0)
		expect(calls.shares).toHaveLength(0)
		expect(calls.loads).toHaveLength(0)
		expect(calls.storageKeys).toHaveLength(0)
	})

	for (const scenario of [
		{ name: 'no cookie', query: '', cookie: null },
		{ name: 'wrong cookie name', query: '', cookie: 'wsps=not-secure' },
		{
			name: 'duplicate secure cookies',
			query: '',
			cookie: `${secureCookie('first')}; ${secureCookie('second')}`,
		},
		{ name: 'empty share parameter', query: `?${PRIVATE_SHARE_QUERY_PARAM}=`, cookie: null },
		{ name: 'empty handoff parameter', query: `?${PRIVATE_GRANT_QUERY_PARAM}=`, cookie: null },
	]) {
		test(`keeps ${scenario.name} database-independent and anonymous`, async () => {
			const headers = new Headers()
			if (scenario.cookie) headers.set('cookie', scenario.cookie)
			const response = await servePrivateSite(requestFor('', scenario.query, { headers }), SITE_ID, '')

			expect(response.status).toBe(200)
			expect(await response.text()).toContain('this address needs a share link')
			expect(response.headers.get('referrer-policy')).toBe('no-referrer')
			expectPrivateHeaders(response)
			expect(calls.handoffs).toHaveLength(0)
			expect(calls.shares).toHaveLength(0)
			expect(calls.loads).toHaveLength(0)
			expect(calls.storageKeys).toHaveLength(0)
		})
	}
})

describe('private credential exchanges', () => {
	test('atomically exchanges an unscoped share and removes all credential parameters', async () => {
		exchangeShare = async () => ({ kind: 'share', shareId: 'share-1' })
		const token = 'share-token'
		const response = await servePrivateSite(
			requestFor('docs', `?keep=1&${PRIVATE_SHARE_QUERY_PARAM}=${token}&${PRIVATE_GRANT_QUERY_PARAM}=`),
			SITE_ID,
			'docs',
		)

		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe('/docs?keep=1')
		expect(response.headers.get('set-cookie')).toContain(`${sessionCookieName(true)}=wsx_`)
		expect(response.headers.get('set-cookie')).toContain('Secure')
		expect(response.headers.get('set-cookie')).toContain('HttpOnly')
		expectPrivateHeaders(response)
		expect(calls.shares).toHaveLength(1)
		expect(calls.shares[0]?.siteId).toBe(SITE_ID)
		expect(calls.shares[0]?.tokenHash).toBe(hashShareTokenSync(token))
		expect(calls.handoffs).toHaveLength(0)
		expect(calls.loads).toHaveLength(0)
		expect(calls.touchedShares).toEqual(['share-1'])
	})

	for (const scenario of [
		{
			name: 'a scoped share',
			result: {
				kind: 'audienceMismatch',
				audienceDid: 'did:plc:only-this-account',
			} satisfies PrivateShareTokenExchangeResult,
			status: 200,
		},
		{
			name: 'an empty scoped audience DID',
			result: { kind: 'audienceMismatch', audienceDid: '' } satisfies PrivateShareTokenExchangeResult,
			status: 200,
		},
		{ name: 'a revoked, expired, or unknown share', result: null, status: 404 },
	]) {
		test(`handles ${scenario.name} without loading a session`, async () => {
			exchangeShare = async () => scenario.result
			const token = 'token&lt;&amp;'
			const response = await servePrivateSite(
				requestFor('', `?${PRIVATE_SHARE_QUERY_PARAM}=${encodeURIComponent(token)}`),
				SITE_ID,
				'',
			)

			expect(response.status).toBe(scenario.status)
			if (scenario.status === 200) {
				expect(await response.text()).toContain('this link is for a specific account')
				expect(response.headers.get('referrer-policy')).toBe('strict-origin')
			} else {
				await expectNotFound(response)
			}
			expect(calls.shares).toHaveLength(1)
			expect(calls.handoffs).toHaveLength(0)
			expect(calls.loads).toHaveLength(0)
			expect(calls.storageKeys).toHaveLength(0)
			expect(calls.touchedShares).toHaveLength(0)
		})
	}

	test('keeps a successful exchange redirecting when best-effort share tracking fails', async () => {
		exchangeShare = async () => ({ kind: 'share', shareId: 'share-1' })
		touchGrantedShare = async () => {
			throw new Error('share tracking is unavailable')
		}

		const response = await servePrivateSite(requestFor('', `?${PRIVATE_SHARE_QUERY_PARAM}=share-token`), SITE_ID, '')

		expect(response.status).toBe(302)
		expect(calls.touchedShares).toEqual(['share-1'])
	})

	test('fails closed when the share exchange dependency rejects', async () => {
		exchangeShare = async () => {
			throw new Error('database details must not reach the response')
		}
		const response = await servePrivateSite(requestFor('', `?${PRIVATE_SHARE_QUERY_PARAM}=share-token`), SITE_ID, '')

		await expectNotFound(response)
		expect(calls.shares).toHaveLength(1)
		expect(calls.loads).toHaveLength(0)
	})

	for (const scenario of [
		{
			name: 'owner handoff',
			result: { kind: 'owner', ownerDid: 'did:plc:owner' } satisfies PrivateHandoffExchangeResult,
			touched: [] as string[],
		},
		{
			name: 'share handoff',
			result: { kind: 'share', shareId: 'share-from-handoff' } satisfies PrivateHandoffExchangeResult,
			touched: ['share-from-handoff'],
		},
		{ name: 'used or invalid handoff', result: null, touched: [] as string[] },
	]) {
		test(`handles ${scenario.name} before every other credential`, async () => {
			exchangeHandoff = async () => scenario.result
			const handoff = 'one-time-handoff'
			const response = await servePrivateSite(
				requestFor('', `?${PRIVATE_SHARE_QUERY_PARAM}=share-token&${PRIVATE_GRANT_QUERY_PARAM}=${handoff}`),
				SITE_ID,
				'',
			)

			if (scenario.result) {
				expect(response.status).toBe(302)
				expect(response.headers.get('location')).toBe('/')
			} else {
				await expectNotFound(response)
			}
			expect(calls.handoffs).toHaveLength(1)
			expect(calls.handoffs[0]?.secretHash).toBe(hashSecret(handoff))
			expect(calls.shares).toHaveLength(0)
			expect(calls.loads).toHaveLength(0)
			expect(calls.touchedShares).toEqual(scenario.touched)
		})
	}

	test('fails closed when the handoff exchange dependency rejects', async () => {
		exchangeHandoff = async () => {
			throw new Error('handoff database unavailable')
		}
		const response = await servePrivateSite(requestFor('', `?${PRIVATE_GRANT_QUERY_PARAM}=handoff`), SITE_ID, '')

		await expectNotFound(response)
		expect(calls.handoffs).toHaveLength(1)
		expect(calls.shares).toHaveLength(0)
	})

	test('allows exactly one concurrent atomic handoff exchange', async () => {
		let available = true
		exchangeHandoff = async () => {
			if (!available) return null
			available = false
			return { kind: 'owner', ownerDid: 'did:plc:owner' }
		}

		const responses = await Promise.all([
			servePrivateSite(requestFor('', `?${PRIVATE_GRANT_QUERY_PARAM}=single-use`), SITE_ID, ''),
			servePrivateSite(requestFor('', `?${PRIVATE_GRANT_QUERY_PARAM}=single-use`), SITE_ID, ''),
		])

		expect(responses.map((response) => response.status).sort()).toEqual([302, 404])
		expect(calls.handoffs).toHaveLength(2)
		expect(calls.shares).toHaveLength(0)
	})
})

describe('private cookie sessions and files', () => {
	test('uses one authorized aggregate lookup and streams the selected file response', async () => {
		const rawCookie = 'session-secret'
		loadAuthorized = async () => readyAuthorized([file('index.html', 'text/html; charset=utf-8')])
		readStorage = async () => encoder.encode('hello')

		const response = await servePrivateSite(
			requestFor('', '', { headers: { cookie: secureCookie(rawCookie) } }),
			SITE_ID,
			'',
		)

		expect(response.status).toBe(200)
		expect(response.body).not.toBeNull()
		expect(await response.text()).toBe('hello')
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
		expect(response.headers.get('content-length')).toBe('5')
		expectPrivateHeaders(response)
		expect(calls.loads).toEqual([{ siteId: SITE_ID, secretHash: hashSecret(rawCookie) }])
		expect(calls.storageKeys).toEqual([`private/${SITE_ID}/index.html`])
		expect(calls.handoffs).toHaveLength(0)
		expect(calls.shares).toHaveLength(0)
	})

	test('keeps server HEAD and Range response semantics after authorization', async () => {
		loadAuthorized = async () => readyAuthorized([file('index.html')])
		readStorage = async () => encoder.encode('hello')
		const app = new Hono()
		app.get('/*', (context) => servePrivateSite(context.req.raw, SITE_ID, 'index.html'))
		const headers = { cookie: secureCookie('session-secret') }

		const headResponse = await app.request(
			new Request(`https://${SITE_ID}.priv.wisp.place/`, { method: 'HEAD', headers }),
		)
		expect(headResponse.status).toBe(200)
		expect(headResponse.headers.get('content-length')).toBe('5')
		expect(await headResponse.text()).toBe('')

		const rangeResponse = await app.request(
			new Request(`https://${SITE_ID}.priv.wisp.place/`, {
				headers: { ...headers, range: 'bytes=1-3' },
			}),
		)
		expect(rangeResponse.status).toBe(200)
		expect(rangeResponse.headers.get('content-range')).toBeNull()
		expect(await rangeResponse.text()).toBe('hello')
	})

	for (const scenario of [
		{ name: 'an unknown or expired session', load: async () => null, status: 200 },
		{
			name: 'an unavailable authorized-site dependency',
			load: async () => {
				throw new Error('database failure')
			},
			status: 404,
		},
	]) {
		test(`handles ${scenario.name} without reading storage`, async () => {
			loadAuthorized = scenario.load
			const response = await servePrivateSite(
				requestFor('', '', { headers: { cookie: secureCookie('session-secret') } }),
				SITE_ID,
				'',
			)

			if (scenario.status === 200) {
				expect(await response.text()).toContain('this address needs a share link')
			} else {
				await expectNotFound(response)
			}
			expect(calls.loads).toHaveLength(1)
			expect(calls.storageKeys).toHaveLength(0)
		})
	}

	for (const scenario of [
		{
			name: 'an exact file before its directory index',
			requested: 'docs',
			files: [file('docs'), file('docs/index.html')],
			target: 'docs',
		},
		{
			name: 'the root index preference',
			requested: '',
			files: [file('index.htm'), file('index.html')],
			target: 'index.html',
		},
		{ name: 'a directory index', requested: 'docs', files: [file('docs/index.htm')], target: 'docs/index.htm' },
		{
			name: 'a legacy root exact file',
			requested: 'guide.txt',
			files: [file('dist/guide.txt')],
			target: 'dist/guide.txt',
		},
		{
			name: 'a legacy root directory index',
			requested: 'docs',
			files: [file('dist/docs/index.html')],
			target: 'dist/docs/index.html',
		},
		{ name: 'a missing target', requested: 'missing', files: [file('index.html')], target: null },
	]) {
		test(`resolves ${scenario.name}`, async () => {
			loadAuthorized = async () => readyAuthorized(scenario.files)
			readStorage = async () => encoder.encode(`body:${scenario.target}`)
			const response = await servePrivateSite(
				requestFor(scenario.requested, '', { headers: { cookie: secureCookie('session-secret') } }),
				SITE_ID,
				scenario.requested,
			)

			if (scenario.target === null) {
				await expectNotFound(response)
				expect(calls.storageKeys).toHaveLength(0)
				return
			}
			expect(response.status).toBe(200)
			expect(await response.text()).toBe(`body:${scenario.target}`)
			expect(calls.storageKeys).toEqual([`private/${SITE_ID}/${scenario.target}`])
		})
	}

	for (const scenario of [
		{ name: 'an empty stored path', files: [file('')] },
		{ name: 'a traversal stored path', files: [file('../secret.txt')] },
		{ name: 'a trailing-slash stored path', files: [file('assets/')] },
		{ name: 'a backslash stored path', files: [file('assets\\secret.txt')] },
	]) {
		test(`fails closed for ${scenario.name}`, async () => {
			loadAuthorized = async () => readyAuthorized(scenario.files)
			const response = await servePrivateSite(
				requestFor('', '', { headers: { cookie: secureCookie('session-secret') } }),
				SITE_ID,
				'',
			)

			await expectNotFound(response)
			expect(calls.loads).toHaveLength(1)
			expect(calls.storageKeys).toHaveLength(0)
		})
	}

	for (const scenario of [
		{ name: 'a missing stored object', read: async () => null },
		{
			name: 'a storage dependency failure',
			read: async () => {
				throw new Error('storage failure')
			},
		},
	]) {
		test(`returns generic not-found for ${scenario.name}`, async () => {
			loadAuthorized = async () => readyAuthorized([file('index.html')])
			readStorage = scenario.read
			const response = await servePrivateSite(
				requestFor('', '', { headers: { cookie: secureCookie('session-secret') } }),
				SITE_ID,
				'',
			)

			await expectNotFound(response)
			expect(calls.storageKeys).toEqual([`private/${SITE_ID}/index.html`])
		})
	}
})

test('privateNotFound always uses the generic no-store response', async () => {
	await expectNotFound(privateNotFound())
})
