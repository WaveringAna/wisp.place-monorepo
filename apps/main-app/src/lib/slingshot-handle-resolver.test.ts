import { describe, expect, test } from 'bun:test'
import { SlingshotHandleResolver } from './slingshot-handle-resolver'

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 as const }
const ENDPOINT = 'https://resolver.example/xrpc/com.atproto.identity.resolveHandle'

function resolverFor(body: unknown, options: { addresses?: readonly { address: string; family: 4 | 6 }[] } = {}) {
	const requests: string[] = []
	const resolver = new SlingshotHandleResolver(ENDPOINT, {
		resolver: async () => options.addresses ?? [PUBLIC_ADDRESS],
		transport: async ({ url }) => {
			requests.push(url.toString())
			return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
		},
	})
	return { resolver, requests }
}

describe('SlingshotHandleResolver transport and validation', () => {
	test('pins the resolver request and accepts only supported DIDs', async () => {
		const { resolver, requests } = resolverFor({ did: 'did:web:example.com' })
		expect(await resolver.resolve('Alice.Example')).toBe('did:web:example.com')
		expect(requests).toEqual([`${ENDPOINT}?handle=alice.example`])
	})

	test('rejects malformed DID responses and unsafe DNS answers before transport', async () => {
		const malformed = resolverFor({ did: 'did:evil:private' })
		expect(await malformed.resolver.resolve('alice.example')).toBeNull()
		expect(malformed.requests).toHaveLength(1)

		const unsafe = resolverFor({ did: 'did:web:example.com' }, { addresses: [{ address: '10.0.0.1', family: 4 }] })
		expect(await unsafe.resolver.resolve('alice.example')).toBeNull()
		expect(unsafe.requests).toHaveLength(0)
	})

	test('bounds resolver responses and rejects non-HTTPS endpoints', async () => {
		const oversized = resolverFor({ did: 'did:web:example.com', padding: 'x'.repeat(64 * 1024) })
		expect(await oversized.resolver.resolve('alice.example')).toBeNull()

		const http = new SlingshotHandleResolver('http://resolver.example/xrpc/com.atproto.identity.resolveHandle', {
			resolver: async () => [PUBLIC_ADDRESS],
			transport: async () => new Response(JSON.stringify({ did: 'did:web:example.com' })),
		})
		expect(await http.resolve('alice.example')).toBeNull()
	})

	test('propagates caller cancellation through the pinned request', async () => {
		const controller = new AbortController()
		const resolver = new SlingshotHandleResolver(ENDPOINT, {
			resolver: async () => [PUBLIC_ADDRESS],
			transport: async () => new Promise<Response>(() => undefined),
		})
		const pending = resolver.resolve('alice.example', { signal: controller.signal })
		controller.abort()
		await expect(pending).rejects.toThrow()
	})

	test('does not send requests for invalid handles', async () => {
		const { resolver, requests } = resolverFor({ did: 'did:web:example.com' })
		expect(await resolver.resolve('not a handle')).toBeNull()
		expect(requests).toHaveLength(0)
	})
})
