import { describe, expect, test } from 'bun:test'
import type { SafeFetchResolver, SafeFetchTransport } from '@wispplace/safe-fetch'
import { didWebToHttps, getDidDocument, isValidAtprotoIdentifier, resolveDid } from './utils'

const DID = 'did:plc:abcdefghijklmnopqrstuvwx'

const resolver: SafeFetchResolver = async (hostname) => {
	const addresses: Record<string, string> = {
		'resolver.example': '93.184.216.34',
		'plc.example': '1.1.1.1',
		'example.com': '8.8.8.8',
	}
	return [{ address: addresses[hostname] || '93.184.216.34', family: 4 }]
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
}

describe('hosting identity input validation', () => {
	test('accepts supported DIDs and canonical handles only', () => {
		for (const identifier of [DID, 'did:web:example.com', 'did:web:example.com:users:alice', 'alice.example']) {
			expect(isValidAtprotoIdentifier(identifier)).toBe(true)
		}
		for (const identifier of [
			'',
			'localhost',
			'http://127.0.0.1',
			'did:evil:target',
			'did:plc:abc123',
			'did:plc:abcdefghijklmnopqrstuvwxy',
			'did:web:example.com/../../admin',
			'did:web:example.com%2f.evil',
			'did:web:example.com:.',
			'did:web:example.com:..',
			'alice..example',
			'Alice.example',
		]) {
			expect(isValidAtprotoIdentifier(identifier)).toBe(false)
		}
	})

	test('builds canonical did:web document URLs, including an encoded port', () => {
		expect(didWebToHttps('did:web:example.com')).toBe('https://example.com/.well-known/did.json')
		expect(didWebToHttps('did:web:example.com:users:alice')).toBe('https://example.com/users/alice/did.json')
		expect(didWebToHttps('did:web:example.com%3A8443:users')).toBe('https://example.com:8443/users/did.json')
		expect(() => didWebToHttps('did:web:example.com:.')).toThrow('Invalid did:web format')
		expect(() => didWebToHttps('did:web:example.com:..')).toThrow('Invalid did:web format')
	})

	test('uses the pinned safe-fetch resolver/transport for handle and PLC resolution', async () => {
		const did = DID
		const requests: Array<{ host: string; address: string; url: string }> = []
		const transport: SafeFetchTransport = async (request) => {
			requests.push({ host: request.url.hostname, address: request.address.address, url: request.url.toString() })
			if (request.url.hostname === 'resolver.example') return jsonResponse({ did })
			if (request.url.hostname === 'plc.example') return jsonResponse({ alsoKnownAs: ['at://alice.example'] })
			return new Response('unexpected', { status: 500 })
		}

		const result = await resolveDid('alice.example', {
			handleResolverUrl: 'https://resolver.example/xrpc/com.atproto.identity.resolveHandle',
			plcDirectoryUrl: 'https://plc.example',
			fetchOptions: { resolver, transport },
		})

		expect(result).toBe(did)
		expect(requests).toHaveLength(2)
		expect(requests[0]).toMatchObject({ host: 'resolver.example', address: '93.184.216.34' })
		expect(requests[0]?.url).toContain('handle=alice.example')
		expect(requests[1]).toMatchObject({ host: 'plc.example', address: '1.1.1.1' })
		expect(requests[1]?.url).toContain(encodeURIComponent(did))
	})

	test('resolves did:web documents through the same hardened transport', async () => {
		let requestedUrl = ''
		const transport: SafeFetchTransport = async (request) => {
			requestedUrl = request.url.toString()
			return jsonResponse({ alsoKnownAs: ['at://alice.example'] })
		}
		const document = await getDidDocument('did:web:example.com:users:alice', {
			fetchOptions: { resolver, transport },
		})

		expect(document?.alsoKnownAs).toEqual(['at://alice.example'])
		expect(requestedUrl).toBe('https://example.com/users/alice/did.json')
	})

	test('requires a DID document to bind the resolved DID to the requested handle', async () => {
		const transport: SafeFetchTransport = async (request) => {
			if (request.url.hostname === 'resolver.example') return jsonResponse({ did: DID })
			return jsonResponse({ alsoKnownAs: ['at://other.example'] })
		}
		await expect(
			resolveDid('alice.example', {
				handleResolverUrl: 'https://resolver.example/xrpc',
				plcDirectoryUrl: 'https://plc.example',
				fetchOptions: { resolver, transport },
			}),
		).resolves.toBeNull()
	})

	test('rejects an insecure local resolver URL before any request is sent', async () => {
		let calls = 0
		const transport: SafeFetchTransport = async () => {
			calls++
			return jsonResponse({ did: DID })
		}
		await expect(
			resolveDid('alice.example', {
				handleResolverUrl: 'http://127.0.0.1/xrpc',
				fetchOptions: { resolver, transport },
			}),
		).resolves.toBeNull()
		expect(calls).toBe(0)
	})
})
