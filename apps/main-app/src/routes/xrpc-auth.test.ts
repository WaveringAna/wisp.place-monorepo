import { afterEach, describe, expect, test } from 'bun:test'
import { P256PrivateKeyExportable } from '@atcute/crypto'
import { createServiceJwt } from '@atcute/xrpc-server/auth'
import type { IdentityDnsResolver, PinnedIdentityRequest } from '@wispplace/atproto-utils'
import { createXrpcServiceJwtVerifier } from './xrpc-auth'

const audience = 'did:web:wisp.place'
const lxm = 'place.wisp.v2.site.getList'
const publicAddress = { address: '93.184.216.34', family: 4 as const }
const publicDns: IdentityDnsResolver = async () => [publicAddress]
const key = await P256PrivateKeyExportable.createKeypair()
const wrongKey = await P256PrivateKeyExportable.createKeypair()
const publicKeyMultibase = await key.exportPublicKey('multikey')
const document = (did: string) => ({
	id: did,
	verificationMethod: [{ id: `${did}#atproto`, controller: did, type: 'Multikey', publicKeyMultibase }],
})
const token = (issuer: `did:${string}:${string}`, valid = true) =>
	createServiceJwt({ keypair: valid ? key : wrongKey, issuer, audience, lxm })
const response = (did: string) => Response.json(document(did))
const originalEnv = {
	NODE_ENV: process.env.NODE_ENV,
	WISP_ALLOW_LOCALHOST_FETCH: process.env.WISP_ALLOW_LOCALHOST_FETCH,
	WISP_PLC_DIRECTORY_URL: process.env.WISP_PLC_DIRECTORY_URL,
}
afterEach(() => {
	for (const [name, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
})

describe('XRPC service-JWT DID web resolution', () => {
	test('forged JWT cannot make the resolver contact a real localhost listener', async () => {
		process.env.NODE_ENV = 'production'
		let hits = 0
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch() {
				hits++
				return Response.json({})
			},
		})
		try {
			const issuer = `did:web:localhost%3A${server.port}` as const
			const verifier = createXrpcServiceJwtVerifier(audience)
			expect((await verifier.verify(await token(issuer, false), { lxm })).ok).toBe(false)
			expect(hits).toBe(0)
		} finally {
			await server.stop(true)
		}
	})

	for (const issuer of [
		'did:web:localhost',
		'did:web:127.0.0.1',
		'did:web:10.0.0.1',
		'did:web:169.254.169.254',
	] as const) {
		test(`invalid signature cannot reach ${issuer}`, async () => {
			process.env.NODE_ENV = 'production'
			process.env.WISP_ALLOW_LOCALHOST_FETCH = '1'
			let calls = 0
			const verifier = createXrpcServiceJwtVerifier(audience, {
				resolver: publicDns,
				transport: async () => {
					calls++
					return response(issuer)
				},
			})
			expect((await verifier.verify(await token(issuer, false), { lxm })).ok).toBe(false)
			expect(calls).toBe(0)
		})
	}

	test('rejects private and mixed DNS answers before opening transport', async () => {
		for (const answers of [
			[{ address: '192.168.1.1', family: 4 as const }],
			[publicAddress, { address: '127.0.0.1', family: 4 as const }],
		]) {
			let calls = 0
			const verifier = createXrpcServiceJwtVerifier(audience, {
				resolver: async () => answers,
				transport: async () => {
					calls++
					return response('did:web:attacker.example')
				},
			})
			expect((await verifier.verify(await token('did:web:attacker.example', false), { lxm })).ok).toBe(false)
			expect(calls).toBe(0)
		}
	})

	test('pins one public answer and preserves did:web ports and paths', async () => {
		let lookups = 0
		const requests: PinnedIdentityRequest[] = []
		const issuer = 'did:web:public.example%3A8443:users:alice'
		const verifier = createXrpcServiceJwtVerifier(audience, {
			resolver: async () => (++lookups === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }]),
			transport: async (request) => {
				requests.push(request)
				return response(issuer)
			},
		})
		expect((await verifier.verify(await token(issuer), { lxm })).ok).toBe(true)
		expect(lookups).toBe(1)
		expect(requests[0]?.address).toEqual(publicAddress)
		expect(requests[0]?.url.href).toBe('https://public.example:8443/users/alice/did.json')
		expect(requests[0]?.timeoutMs).toBe(5_000)
	})

	test('an invalid signature refresh cannot rebind to private DNS', async () => {
		let lookups = 0
		let calls = 0
		const issuer = 'did:web:rebind.example'
		const verifier = createXrpcServiceJwtVerifier(audience, {
			resolver: async () => (++lookups === 1 ? [publicAddress] : [{ address: '10.0.0.1', family: 4 }]),
			transport: async () => {
				calls++
				return response(issuer)
			},
		})
		expect((await verifier.verify(await token(issuer, false), { lxm })).ok).toBe(false)
		expect(lookups).toBe(2)
		expect(calls).toBe(1)
	})

	test('does not follow redirects, even to a public address', async () => {
		let calls = 0
		const verifier = createXrpcServiceJwtVerifier(audience, {
			resolver: publicDns,
			transport: async () => {
				calls++
				return Response.redirect('https://elsewhere.example/did.json')
			},
		})
		expect((await verifier.verify(await token('did:web:public.example'), { lxm })).ok).toBe(false)
		expect(calls).toBe(1)
	})

	test('caps streamed bodies without trusting content-length', async () => {
		let cancelled = false
		const verifier = createXrpcServiceJwtVerifier(audience, {
			resolver: publicDns,
			transport: async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(20 * 1024 + 1))
						},
						cancel() {
							cancelled = true
						},
					}),
					{ headers: { 'content-type': 'application/json' } },
				),
		})
		expect((await verifier.verify(await token('did:web:large.example'), { lxm })).ok).toBe(false)
		expect(cancelled).toBe(true)
	})

	test('total deadline includes a stalled DNS resolver', async () => {
		let calls = 0
		const verifier = createXrpcServiceJwtVerifier(audience, {
			resolver: () => new Promise(() => {}),
			transport: async () => {
				calls++
				return response('did:web:slow.example')
			},
		})
		const start = Date.now()
		expect((await verifier.verify(await token('did:web:slow.example'), { lxm })).ok).toBe(false)
		expect(Date.now() - start).toBeLessThan(6_000)
		expect(calls).toBe(0)
	}, 7_000)

	test('total deadline also cancels a stalled response body', async () => {
		let cancelled = false
		let signal: AbortSignal | undefined
		const verifier = createXrpcServiceJwtVerifier(audience, {
			resolver: publicDns,
			transport: async (request) => {
				signal = request.signal
				return new Response(
					new ReadableStream({
						cancel() {
							cancelled = true
						},
					}),
					{
						headers: { 'content-type': 'application/json' },
					},
				)
			},
		})
		const start = Date.now()
		expect((await verifier.verify(await token('did:web:slow-body.example'), { lxm })).ok).toBe(false)
		expect(Date.now() - start).toBeLessThan(6_000)
		expect(signal?.aborted).toBe(true)
		expect(cancelled).toBe(true)
	}, 7_000)

	test('preserves the configured PLC resolver and real signature verification', async () => {
		const issuer = 'did:plc:abcdefghijklmnopqrstuvwx'
		const paths: string[] = []
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch(request) {
				paths.push(new URL(request.url).pathname)
				return response(issuer)
			},
		})
		try {
			process.env.WISP_PLC_DIRECTORY_URL = `http://127.0.0.1:${server.port}`
			const verifier = createXrpcServiceJwtVerifier(audience, {
				transport: async () => {
					throw new Error('web transport must not handle PLC')
				},
			})
			expect((await verifier.verify(await token(issuer), { lxm })).ok).toBe(true)
			expect(paths).toEqual([`/${encodeURIComponent(issuer)}`])
		} finally {
			await server.stop(true)
		}
	})

	test('development opt-in still forbids LAN addresses', async () => {
		process.env.NODE_ENV = 'development'
		process.env.WISP_ALLOW_LOCALHOST_FETCH = '1'
		let calls = 0
		const verifier = createXrpcServiceJwtVerifier(audience, {
			resolver: async () => [{ address: '192.168.1.1', family: 4 }],
			transport: async () => {
				calls++
				return response('did:web:lan.example')
			},
		})
		expect((await verifier.verify(await token('did:web:lan.example', false), { lxm })).ok).toBe(false)
		expect(calls).toBe(0)
	})

	for (const [nodeEnv, flag, allowed] of [
		['development', undefined, false],
		['test', '1', false],
		['development', '1', true],
	] as const) {
		test(`localhost requires explicit development flags: ${nodeEnv}/${flag}`, async () => {
			process.env.NODE_ENV = nodeEnv
			if (flag === undefined) delete process.env.WISP_ALLOW_LOCALHOST_FETCH
			else process.env.WISP_ALLOW_LOCALHOST_FETCH = flag
			let calls = 0
			const issuer = 'did:web:localhost%3A3300'
			const verifier = createXrpcServiceJwtVerifier(audience, {
				resolver: async () => [{ address: '127.0.0.1', family: 4 }],
				transport: async ({ url }) => {
					calls++
					expect(url.href).toBe('http://localhost:3300/.well-known/did.json')
					return response(issuer)
				},
			})
			expect((await verifier.verify(await token(issuer), { lxm })).ok).toBe(allowed)
			expect(calls).toBe(allowed ? 1 : 0)
		})
	}
})
