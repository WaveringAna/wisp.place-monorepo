import { describe, expect, test } from 'bun:test'
import {
	createCachedIdentityFetcher,
	createPinnedIdentityFetcher,
	didWebToHttps,
	getPdsForDid,
	isPublicIdentityAddress,
	MAX_IDENTITY_JSON_BYTES,
	validatePdsEndpoint,
} from './identity'

const publicAddress = { address: '93.184.216.34', family: 4 as const }

describe('identity fetch injection and document validation', () => {
	test('uses the supplied fetcher for the DID document before returning a PDS endpoint', async () => {
		const requests: string[] = []
		const pds = await getPdsForDid('did:web:example.com', async (url) => {
			requests.push(url)
			return new Response(
				JSON.stringify({
					service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example' }],
				}),
			)
		})

		expect(requests).toEqual(['https://example.com/.well-known/did.json'])
		expect(pds).toBe('https://pds.example')
	})

	test('rejects hostile did:web authority and path components before fetching', async () => {
		for (const did of [
			'did:web:trusted.example%40127.0.0.1',
			'did:web:trusted.example%2F%2E%2E%2Fprivate',
			'did:web:trusted.example:%2E%2E',
			'did:web:trusted.example%3Ftarget%3D127.0.0.1',
			'did:web:127.0.0.1',
			'did:web:localhost',
		]) {
			expect(() => didWebToHttps(did)).toThrow('Invalid did:web format')
		}

		let calls = 0
		const pds = await getPdsForDid('did:web:trusted.example%40127.0.0.1', async () => {
			calls++
			return new Response('{}')
		})
		expect(pds).toBeNull()
		expect(calls).toBe(0)
	})

	test('rejects credentialed, HTTP, and private literal PDS endpoints', async () => {
		const endpoints = [
			'https://user:password@pds.example',
			'http://pds.example',
			'https://127.0.0.1',
			'https://[::1]',
			'ftp://pds.example',
		]
		for (const endpoint of endpoints) {
			const pds = await getPdsForDid(
				'did:web:example.com',
				async () => new Response(JSON.stringify({ service: [{ id: '#atproto_pds', serviceEndpoint: endpoint }] })),
			)
			expect(pds).toBeNull()
		}
		expect(validatePdsEndpoint('https://pds.example/base')).toBe('https://pds.example/base')
	})

	test('recognizes special IPv4 and IPv6 addresses as non-public', () => {
		const specialVectors = [
			['private', '10.0.0.1'],
			['loopback', '127.0.0.1'],
			['link-local', '169.254.169.254'],
			['carrier-grade NAT', '100.64.0.1'],
			['benchmarking', '198.18.0.1'],
			['AMT', '192.52.193.1'],
			['AS112 IPv4', '192.31.196.1'],
			['IPv6 loopback', '::1'],
			['IPv6 ULA', 'fc00::1'],
			['documentation', '2001:db8::1'],
			['well-known NAT64', '64:ff9b::c0a8:1'],
			['local-use NAT64', '64:ff9b:1::c0a8:1'],
			['AS112 IPv6', '2620:4f:8000::1'],
			['ORCHID', '2001:10::1'],
			['ORCHIDv2', '2001:20::1'],
		] as const
		for (const [_name, address] of specialVectors) expect(isPublicIdentityAddress(address)).toBe(false)
		expect(isPublicIdentityAddress('93.184.216.34')).toBe(true)
		expect(isPublicIdentityAddress('2606:4700:4700::1111')).toBe(true)
	})
})

describe('pinned identity transport', () => {
	test('rejects mixed DNS answers before any socket transport is called', async () => {
		let calls = 0
		const fetcher = createPinnedIdentityFetcher({
			resolver: async () => [publicAddress, { address: '10.0.0.7', family: 4 }],
			transport: async () => {
				calls++
				return new Response('{}')
			},
		})

		await expect(fetcher('https://identity.example/did.json')).rejects.toThrow('Identity DNS address is not public')
		expect(calls).toBe(0)
	})

	test('pins the checked address and revalidates a redirect target before connecting', async () => {
		const addresses: string[] = []
		let calls = 0
		const fetcher = createPinnedIdentityFetcher({
			resolver: async (hostname) =>
				hostname === 'rebound.example' ? [{ address: '127.0.0.1', family: 4 }] : [publicAddress],
			transport: async ({ address }) => {
				calls++
				addresses.push(address.address)
				return new Response(null, { status: 302, headers: { location: 'https://rebound.example/private' } })
			},
		})

		await expect(fetcher('https://identity.example/did.json')).rejects.toThrow('Identity DNS address is not public')
		expect(addresses).toEqual(['93.184.216.34'])
		expect(calls).toBe(1)
	})

	test('bounds an untrusted response body before returning it', async () => {
		const fetcher = createPinnedIdentityFetcher({
			resolver: async () => [publicAddress],
			transport: async () => new Response('x'.repeat(MAX_IDENTITY_JSON_BYTES + 1)),
		})
		await expect(fetcher('https://identity.example/did.json')).rejects.toThrow('Identity response exceeds size limit')
	})
})

describe('cached identity fetcher', () => {
	test('deduplicates canonical in-flight requests and returns independently readable bodies', async () => {
		let calls = 0
		let resolveResponse: ((response: Response) => void) | undefined
		const pending = new Promise<Response>((resolve) => {
			resolveResponse = resolve
		})
		const cached = createCachedIdentityFetcher(async () => {
			calls++
			return pending
		})

		const first = cached('https://identity.example/did.json')
		const second = cached('https://identity.example/did.json#ignored')
		expect(calls).toBe(1)
		resolveResponse?.(new Response('same-body'))
		const [one, two] = await Promise.all([first, second])
		expect(await one.text()).toBe('same-body')
		expect(await two.text()).toBe('same-body')
	})

	test('lets one cancelled shared waiter detach without cancelling another', async () => {
		let calls = 0
		let sourceSignal: AbortSignal | undefined
		let resolveResponse: ((response: Response) => void) | undefined
		const cached = createCachedIdentityFetcher(
			(_url, options) =>
				new Promise<Response>((resolve) => {
					calls++
					sourceSignal = options?.signal
					resolveResponse = resolve
				}),
		)
		const cancelled = new AbortController()
		const first = cached('https://identity.example/shared', { signal: cancelled.signal })
		const second = cached('https://identity.example/shared')
		expect(calls).toBe(1)
		cancelled.abort()
		await expect(first).rejects.toThrow('Identity request aborted')
		expect(sourceSignal?.aborted).toBe(false)
		resolveResponse?.(new Response('remaining waiter'))
		expect(await (await second).text()).toBe('remaining waiter')
	})

	test('aborts an abandoned shared source and enforces its independent timeout', async () => {
		let abandonedSignal: AbortSignal | undefined
		const abandoned = createCachedIdentityFetcher((_url, options) => {
			abandonedSignal = options?.signal
			return new Promise<Response>(() => undefined)
		})
		const caller = new AbortController()
		const pending = abandoned('https://identity.example/abandoned', { signal: caller.signal })
		caller.abort()
		await expect(pending).rejects.toThrow('Identity request aborted')
		expect(abandonedSignal?.aborted).toBe(true)

		let timeoutSignal: AbortSignal | undefined
		const timed = createCachedIdentityFetcher(
			(_url, options) => {
				timeoutSignal = options?.signal
				return new Promise<Response>(() => undefined)
			},
			{ inFlightTimeoutMs: 0 },
		)
		await expect(timed('https://identity.example/timed')).rejects.toThrow('Identity cache request timed out')
		expect(timeoutSignal?.aborted).toBe(true)
	})

	test('uses a bounded LRU positive cache and expires entries', async () => {
		let now = 0
		let calls = 0
		const cached = createCachedIdentityFetcher(async () => new Response(`body-${++calls}`), {
			maxEntries: 2,
			now: () => now,
			staleTtlMs: 0,
			ttlMs: 100,
		})

		expect(await (await cached('https://identity.example/a')).text()).toBe('body-1')
		expect(await (await cached('https://identity.example/b')).text()).toBe('body-2')
		expect(await (await cached('https://identity.example/a')).text()).toBe('body-1')
		expect(await (await cached('https://identity.example/c')).text()).toBe('body-3')
		expect(await (await cached('https://identity.example/b')).text()).toBe('body-4')
		now = 101
		expect(await (await cached('https://identity.example/a')).text()).toBe('body-5')
	})

	test('does not cache failures by default and only serves stale data when explicitly requested', async () => {
		let now = 0
		let mode: 'success' | 'failure' = 'success'
		let calls = 0
		const cached = createCachedIdentityFetcher(
			async () => {
				calls++
				if (mode === 'failure') throw new Error('private URL must not escape')
				return new Response('cached')
			},
			{ now: () => now, staleTtlMs: 100, ttlMs: 10 },
		)

		await cached('https://identity.example/did.json')
		now = 11
		mode = 'failure'
		await expect(cached('https://identity.example/did.json')).rejects.toThrow('private URL must not escape')
		expect(await (await cached.get('https://identity.example/did.json', { allowStale: true })).text()).toBe('cached')
		expect(await (await cached.get('https://identity.example/did.json', { staleIfError: true })).text()).toBe('cached')
		await expect(cached('https://identity.example/error')).rejects.toThrow('private URL must not escape')
		await expect(cached('https://identity.example/error')).rejects.toThrow('private URL must not escape')
		expect(calls).toBe(5)
	})

	test('cannot repopulate after invalidation and preserves no-body status responses', async () => {
		let calls = 0
		const resolvers: Array<(response: Response) => void> = []
		const cached = createCachedIdentityFetcher(
			() =>
				new Promise<Response>((resolve) => {
					calls++
					resolvers.push(resolve)
				}),
		)
		const first = cached('https://identity.example/rebind')
		cached.invalidate('https://identity.example/rebind')
		const second = cached('https://identity.example/rebind')
		expect(calls).toBe(2)
		resolvers[0]?.(new Response('old'))
		expect(await (await first).text()).toBe('old')
		resolvers[1]?.(new Response('new'))
		expect(await (await second).text()).toBe('new')
		expect(await (await cached('https://identity.example/rebind')).text()).toBe('new')
		expect(calls).toBe(2)

		const noBody = createCachedIdentityFetcher(async () => new Response(null, { status: 204 }))
		expect((await noBody('https://identity.example/empty')).status).toBe(204)
		expect((await noBody('https://identity.example/empty')).status).toBe(204)
	})

	test('caps aggregate cached response bytes instead of only entry count', async () => {
		let calls = 0
		const cached = createCachedIdentityFetcher(async () => new Response(`${++calls}`.repeat(2)), {
			maxCacheBytes: 3,
			maxEntries: 10,
		})

		expect(await (await cached('https://identity.example/a')).text()).toBe('11')
		expect(await (await cached('https://identity.example/b')).text()).toBe('22')
		// Adding b exceeds the 3-byte aggregate budget, evicting the LRU a.
		expect(await (await cached('https://identity.example/a')).text()).toBe('33')
		expect(calls).toBe(3)
	})

	test('bounds negative caching and validates cache options eagerly', async () => {
		let now = 0
		let calls = 0
		const cached = createCachedIdentityFetcher(
			async () => {
				calls++
				return new Response('no', { status: 500 })
			},
			{ failureTtlMs: 1_000_000, now: () => now },
		)
		await cached('https://identity.example/failure')
		await cached('https://identity.example/failure')
		expect(calls).toBe(1)
		now = 10_001
		await cached('https://identity.example/failure')
		expect(calls).toBe(2)
		expect(() => createCachedIdentityFetcher(async () => new Response('ok'), { maxResponseBytes: -1 })).toThrow(
			'Identity response limit is invalid',
		)
		expect(() => createCachedIdentityFetcher(async () => new Response('ok'), { maxCacheBytes: -1 })).toThrow(
			'Identity cache byte limit is invalid',
		)
		expect(() => createCachedIdentityFetcher(async () => new Response('ok'), { inFlightTimeoutMs: -1 })).toThrow(
			'Identity cache in-flight timeout is invalid',
		)
		expect(() => createCachedIdentityFetcher(async () => new Response('ok'), { maxInFlight: 0 })).toThrow(
			'Identity cache in-flight limit is invalid',
		)
	})
})
