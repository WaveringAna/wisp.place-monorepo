import { describe, expect, test } from 'bun:test'
import {
	assertSafeWebhookUrl,
	assertSafeWebhookUrlSyntax,
	isPublicWebhookIpAddress,
	pinnedWebhookFetch,
	WebhookUrlError,
} from './webhook-url'

describe('webhook URL validation', () => {
	test('requires HTTPS URLs without credentials', () => {
		expect(() => assertSafeWebhookUrlSyntax('http://example.com/webhook')).toThrow('HTTPS')
		expect(() => assertSafeWebhookUrlSyntax('https://user:pass@example.com/webhook')).toThrow('credentials')
		expect(() => assertSafeWebhookUrlSyntax('https://example.com/webhook')).not.toThrow()
	})

	test('blocks direct private, CGNAT, mapped, compatible, and NAT64 destinations', async () => {
		expect(() => assertSafeWebhookUrlSyntax('https://metadata.google.internal/latest')).toThrow('private address')
		for (const url of [
			'https://127.0.0.1/webhook',
			'https://169.254.169.254/latest/meta-data',
			'https://100.64.0.1/webhook',
			'https://[::1]/webhook',
			'https://[::ffff:127.0.0.1]/webhook',
			'https://[::ffff:7f00:1]/webhook',
			'https://[::127.0.0.1]/webhook',
			'https://[64:ff9b::7f00:1]/webhook',
		]) {
			await expect(assertSafeWebhookUrl(url)).rejects.toThrow('private address')
		}
	})

	test('uses a public-only IPv4 and IPv6 policy including special 2001 ranges', () => {
		expect(isPublicWebhookIpAddress('8.8.8.8')).toBe(true)
		expect(isPublicWebhookIpAddress('100.64.0.1')).toBe(false)
		// 2001:0000::/23 intentionally covers IETF special purpose ranges:
		// benchmarking 2001:2, AMT 2001:3, AS112 2001:4:112, ORCHID 2001:10,
		// and ORCHIDv2 2001:20.
		for (const ip of ['2001:2::1', '2001:3::1', '2001:4:112::1', '2001:10::1', '2001:20::1']) {
			expect(isPublicWebhookIpAddress(ip)).toBe(false)
		}
		expect(isPublicWebhookIpAddress('2606:4700:4700::1111')).toBe(true)
	})

	test('rejects mixed public/private DNS answers', async () => {
		const error = await assertSafeWebhookUrl('https://mixed.example/webhook', {
			resolver: async () => [
				{ address: '8.8.8.8', family: 4 },
				{ address: '10.0.0.7', family: 4 },
			],
		}).catch((reason: unknown) => reason)
		expect(error).toBeInstanceOf(WebhookUrlError)
		expect((error as WebhookUrlError).kind).toBe('blocked_destination')
		expect((error as Error).message).toContain('private address')
	})

	test('pins the validated answer at the transport and never performs a second DNS lookup', async () => {
		const addresses: string[] = []
		const response = await pinnedWebhookFetch('https://rebind.example/webhook', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			transport: async (request) => {
				addresses.push(request.address.address)
				return new Response('', { status: 204 })
			},
		})
		expect(response.status).toBe(204)
		expect(addresses).toEqual(['8.8.8.8'])
	})

	test('revalidates redirect targets and does not follow a private redirect', async () => {
		await expect(
			pinnedWebhookFetch('https://public.example/webhook', {
				resolver: async () => [{ address: '8.8.8.8', family: 4 }],
				transport: async () => new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/admin' } }),
			}),
		).rejects.toThrow('private address')
	})

	test('strips signing and credential headers on a public redirect', async () => {
		const requests: Headers[] = []
		const response = await pinnedWebhookFetch('https://first.example/webhook', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			headers: {
				Authorization: 'Bearer never-forward',
				Cookie: 'session=never-forward',
				'X-Webhook-Signature': 'sha256=never-forward',
			},
			transport: async ({ headers }) => {
				requests.push(headers)
				if (requests.length === 1)
					return new Response('', { status: 307, headers: { Location: 'https://second.example/hook' } })
				return new Response('', { status: 204 })
			},
		})
		expect(response.status).toBe(204)
		expect(requests).toHaveLength(2)
		expect(requests[1]?.get('authorization')).toBeNull()
		expect(requests[1]?.get('cookie')).toBeNull()
		expect(requests[1]?.get('x-webhook-signature')).toBeNull()
	})

	test('caps known response bombs and total request time', async () => {
		await expect(
			pinnedWebhookFetch('https://public.example/webhook', {
				resolver: async () => [{ address: '8.8.8.8', family: 4 }],
				transport: async () => new Response('too large', { headers: { 'content-length': '999999' } }),
				maxResponseBytes: 32,
			}),
		).rejects.toThrow('too large')

		await expect(
			pinnedWebhookFetch('https://slow.example/webhook', {
				resolver: async () => [{ address: '8.8.8.8', family: 4 }],
				transport: async ({ signal }) =>
					new Promise<Response>((_resolve, reject) =>
						signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
					),
				timeoutMs: 10,
			}),
		).rejects.toThrow('timed out')
	})

	test('times out a stalled resolver without exposing resolver errors', async () => {
		await expect(
			assertSafeWebhookUrl('https://resolver.example/hook', {
				resolver: async () => new Promise(() => undefined),
				timeoutMs: 10,
			}),
		).rejects.toThrow('timed out')
	})

	test('permits HTTP only for explicit development loopback', () => {
		const oldNodeEnv = process.env.NODE_ENV
		const oldGate = process.env.WISP_ALLOW_LOCALHOST_FETCH
		try {
			process.env.NODE_ENV = 'development'
			process.env.WISP_ALLOW_LOCALHOST_FETCH = '1'
			expect(() => assertSafeWebhookUrlSyntax('http://127.0.0.1:3000/hook', { allowLoopback: true })).not.toThrow()
			expect(() => assertSafeWebhookUrlSyntax('http://10.0.0.1/hook', { allowLoopback: true })).toThrow('HTTPS')
		} finally {
			if (oldNodeEnv === undefined) delete process.env.NODE_ENV
			else process.env.NODE_ENV = oldNodeEnv
			if (oldGate === undefined) delete process.env.WISP_ALLOW_LOCALHOST_FETCH
			else process.env.WISP_ALLOW_LOCALHOST_FETCH = oldGate
		}
	})

	test('enforces HTTPS on every redirect', async () => {
		const error = await pinnedWebhookFetch('https://public.example/start', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			transport: async () => new Response('', { status: 302, headers: { Location: 'http://public.example/final' } }),
		}).catch((reason: unknown) => reason)
		expect(error).toBeInstanceOf(WebhookUrlError)
		expect((error as WebhookUrlError).kind).toBe('invalid_url')
	})

	test('preserves request headers while stripping them only when a redirect changes to GET', async () => {
		const requests: Array<{ method: string; body: string | Uint8Array | undefined; headers: Headers }> = []
		const response = await pinnedWebhookFetch('https://first.example/webhook', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			headers: {
				'Content-Type': 'application/json',
				'X-Webhook-Signature': 'sha256=never-forward',
			},
			body: '{}',
			transport: async (request) => {
				requests.push({ method: request.method, body: request.body, headers: request.headers })
				return requests.length === 1
					? new Response('', { status: 302, headers: { Location: 'https://second.example/hook' } })
					: new Response('', { status: 204 })
			},
		})
		expect(response.status).toBe(204)
		expect(requests).toHaveLength(2)
		expect(requests[0]?.headers.get('content-type')).toBe('application/json')
		expect(requests[0]?.headers.get('content-length')).toBe('2')
		expect(requests[0]?.headers.get('user-agent')).toBeNull()
		expect(requests[1]?.method).toBe('GET')
		expect(requests[1]?.body).toBeUndefined()
		expect(requests[1]?.headers.get('content-type')).toBeNull()
		expect(requests[1]?.headers.get('content-length')).toBeNull()
	})

	test('keeps bounded response and request failures in the webhook error contract', async () => {
		const requestError = await pinnedWebhookFetch('https://public.example/webhook', {
			body: 'too large',
			maxRequestBytes: 2,
		}).catch((reason: unknown) => reason)
		expect(requestError).toBeInstanceOf(WebhookUrlError)
		expect((requestError as WebhookUrlError).kind).toBe('request_too_large')

		const responseError = await pinnedWebhookFetch('https://public.example/webhook', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			maxResponseBytes: 2,
			transport: async () => new Response('too large', { headers: { 'content-length': '9' } }),
		}).catch((reason: unknown) => reason)
		expect(responseError).toBeInstanceOf(WebhookUrlError)
		expect((responseError as WebhookUrlError).kind).toBe('response_too_large')

		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]))
				controller.close()
			},
		})
		const streamedResponse = await pinnedWebhookFetch('https://public.example/webhook', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			maxResponseBytes: 2,
			transport: async () => new Response(body),
		})
		let streamedError: unknown
		try {
			await streamedResponse.arrayBuffer()
		} catch (error) {
			streamedError = error
		}
		expect(streamedError).toBeInstanceOf(WebhookUrlError)
		expect((streamedError as WebhookUrlError).kind).toBe('response_too_large')
	})

	test('preserves an explicitly classified resolver error', async () => {
		const expected = new WebhookUrlError('timeout', 'Webhook request timed out')
		const actual = await assertSafeWebhookUrl('https://resolver.example/hook', {
			resolver: async () => {
				throw expected
			},
		}).catch((reason: unknown) => reason)
		expect(actual).toBe(expected)
	})

	test('maps resolver failures and transport failures without exposing details', async () => {
		const dnsError = await assertSafeWebhookUrl('https://dns.example/hook', {
			resolver: async () => {
				throw new Error('resolver secret')
			},
		}).catch((reason: unknown) => reason)
		expect(dnsError).toBeInstanceOf(WebhookUrlError)
		expect((dnsError as WebhookUrlError).kind).toBe('dns')
		expect((dnsError as Error).message).not.toContain('secret')

		const networkError = await pinnedWebhookFetch('https://public.example/webhook', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			transport: async () => {
				throw new Error('transport secret')
			},
		}).catch((reason: unknown) => reason)
		expect(networkError).toBeInstanceOf(WebhookUrlError)
		expect((networkError as WebhookUrlError).kind).toBe('network')
		expect((networkError as Error).message).not.toContain('secret')
	})

	test('preserves timeout and redirect-limit error kinds', async () => {
		const timeoutError = await pinnedWebhookFetch('https://slow.example/webhook', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			timeoutMs: 10,
			transport: async ({ signal }) =>
				new Promise<Response>((_resolve, reject) =>
					signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
				),
		}).catch((reason: unknown) => reason)
		expect(timeoutError).toBeInstanceOf(WebhookUrlError)
		expect((timeoutError as WebhookUrlError).kind).toBe('timeout')

		const response = await pinnedWebhookFetch('https://slow-body.example/webhook', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			timeoutMs: 10,
			transport: async () => new Response(new ReadableStream<Uint8Array>()),
		})
		let bodyTimeoutError: unknown
		try {
			await response.arrayBuffer()
		} catch (error) {
			bodyTimeoutError = error
		}
		expect(bodyTimeoutError).toBeInstanceOf(WebhookUrlError)
		expect((bodyTimeoutError as WebhookUrlError).kind).toBe('timeout')

		const redirectError = await pinnedWebhookFetch('https://public.example/webhook', {
			resolver: async () => [{ address: '8.8.8.8', family: 4 }],
			maxRedirects: 0,
			transport: async () => new Response('', { status: 302, headers: { Location: '/again' } }),
		}).catch((reason: unknown) => reason)
		expect(redirectError).toBeInstanceOf(WebhookUrlError)
		expect((redirectError as WebhookUrlError).kind).toBe('redirect')
		expect((redirectError as Error).message).toBe('Webhook redirect limit exceeded')
	})
})
