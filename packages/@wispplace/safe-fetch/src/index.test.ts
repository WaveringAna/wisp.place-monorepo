import { describe, expect, test } from 'bun:test'
import {
	DEFAULT_FETCH_TIMEOUT_MS,
	DEFAULT_MAX_REQUEST_BODY_SIZE,
	isPublicIpAddress,
	SafeFetchError,
	SafeFetchHttpError,
	type SafeFetchResolver,
	type SafeFetchTransport,
	safeFetch,
	safeFetchBlob,
	safeFetchJson,
} from './index'

const publicResolver: SafeFetchResolver = async () => [{ address: '93.184.216.34', family: 4 }]

const okTransport: SafeFetchTransport = async () => new Response('ok')

describe('safeFetch public-request defaults', () => {
	test('uses a bounded control-plane timeout', () => {
		expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(30_000)
	})

	test('normalizes an empty method to GET before invoking a custom transport', async () => {
		let observedMethod = ''
		await safeFetch('https://pds.example/xrpc', {
			method: '',
			resolver: publicResolver,
			transport: async (request) => {
				observedMethod = request.method
				return new Response('ok')
			},
		})
		expect(observedMethod).toBe('GET')
	})

	test('keeps classified error causes non-enumerable', () => {
		const cause = new Error('resolver secret')
		const error = new SafeFetchError('dns', 'DNS resolution failed', cause)
		expect(error.cause).toBe(cause)
		expect(Object.keys(error)).not.toContain('cause')
		expect(JSON.stringify(error)).not.toContain('resolver secret')
	})

	test('does not start body, DNS, or transport work after a pre-abort', async () => {
		let bodyReads = 0
		let resolverCalls = 0
		let transportCalls = 0
		class CountingBlob extends Blob {
			override async arrayBuffer(): Promise<ArrayBuffer> {
				bodyReads++
				return await super.arrayBuffer()
			}
		}
		const controller = new AbortController()
		controller.abort(new Error('stop before request'))

		await expect(
			safeFetch('https://pds.example/xrpc', {
				signal: controller.signal,
				body: new CountingBlob(['body']),
				resolver: async () => {
					resolverCalls++
					return [{ address: '93.184.216.34', family: 4 }]
				},
				transport: async () => {
					transportCalls++
					return new Response('unexpected')
				},
			}),
		).rejects.toThrow('stop before request')
		expect(bodyReads).toBe(0)
		expect(resolverCalls).toBe(0)
		expect(transportCalls).toBe(0)
	})

	test('attaches a rejection handler when an operation aborts synchronously', async () => {
		let resolveAddresses: ((value: readonly [{ address: string; family: 4 }]) => void) | undefined
		let rejectionHandlerAttached = false
		const pending = new Promise<readonly [{ address: string; family: 4 }]>((resolve) => {
			resolveAddresses = resolve
		})
		const originalThen = pending.then.bind(pending)
		// biome-ignore lint/suspicious/noThenProperty: Verify that abort races attach a rejection handler.
		pending.then = ((onFulfilled, onRejected) => {
			rejectionHandlerAttached = typeof onRejected === 'function'
			return originalThen(onFulfilled, onRejected)
		}) as typeof pending.then
		const controller = new AbortController()

		await expect(
			safeFetch('https://pds.example/xrpc', {
				signal: controller.signal,
				resolver: () => {
					controller.abort(new Error('stop during DNS'))
					return pending
				},
				transport: okTransport,
			}),
		).rejects.toThrow('stop during DNS')
		expect(rejectionHandlerAttached).toBe(true)
		resolveAddresses?.([{ address: '93.184.216.34', family: 4 }])
	})

	test('rejects non-public IPv4 and IPv6 ranges', () => {
		for (const address of [
			'0.0.0.0',
			'10.0.0.1',
			'100.64.0.1',
			'127.0.0.1',
			'169.254.169.254',
			'172.16.0.1',
			'192.0.0.8',
			'192.0.2.1',
			'192.31.196.1',
			'192.52.193.1',
			'192.168.1.1',
			'192.175.48.1',
			'198.18.0.1',
			'198.51.100.1',
			'203.0.113.1',
			'224.0.0.1',
			'240.0.0.1',
			'::',
			'::1',
			'::ffff:8.8.8.8',
			'fc00::1',
			'fe80::1',
			'ff02::1',
			'64:ff9b::808:808',
			'2001:db8::1',
			'2002:7f00:1::1',
			'2620:4f:8000::1',
		]) {
			expect(isPublicIpAddress(address)).toBe(false)
		}
		expect(isPublicIpAddress('93.184.216.34')).toBe(true)
		expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true)
	})

	test('rejects named IPv6 special-purpose subranges covered by 2001::/23', () => {
		for (const [name, address] of [
			['benchmarking', '2001:2::1'],
			['AMT', '2001:3::1'],
			['AS112', '2001:4:112::1'],
			['ORCHID', '2001:10::1'],
			['ORCHIDv2', '2001:20::1'],
		]) {
			expect(isPublicIpAddress(address), name).toBe(false)
		}
	})

	test('validates every DNS answer before calling the transport', async () => {
		let transportCalls = 0
		await expect(
			safeFetch('https://pds.example/xrpc', {
				resolver: async () => [
					{ address: '93.184.216.34', family: 4 },
					{ address: '10.0.0.7', family: 4 },
				],
				transport: async () => {
					transportCalls++
					return new Response('unexpected')
				},
			}),
		).rejects.toThrow('Blocked non-public address')
		expect(transportCalls).toBe(0)
	})

	test('rejects an immediate default-transport refusal without an uncaught request error', async () => {
		const previousNodeEnv = process.env.NODE_ENV
		const previousLocalhostGate = process.env.WISP_ALLOW_LOCALHOST_FETCH
		const listener = Bun.serve({ port: 0, fetch: () => new Response('unused') })
		const port = listener.port
		listener.stop(true)
		process.env.NODE_ENV = 'development'
		process.env.WISP_ALLOW_LOCALHOST_FETCH = '1'
		try {
			let refusal: unknown
			try {
				await safeFetch(`http://localhost:${port}/`, { allowLocalhost: true, timeout: 1_000 })
			} catch (error) {
				refusal = error
			}
			expect(refusal).toBeInstanceOf(Error)
			expect((refusal as Error & { code?: string }).code).toBe('ECONNREFUSED')
		} finally {
			if (previousNodeEnv === undefined) delete process.env.NODE_ENV
			else process.env.NODE_ENV = previousNodeEnv
			if (previousLocalhostGate === undefined) delete process.env.WISP_ALLOW_LOCALHOST_FETCH
			else process.env.WISP_ALLOW_LOCALHOST_FETCH = previousLocalhostGate
		}
	})

	test('passes a validated DNS answer to the transport for socket pinning', async () => {
		let pinnedAddress = ''
		const response = await safeFetch('https://pds.example/xrpc', {
			resolver: async () => [{ address: '93.184.216.34', family: 4 }],
			transport: async (request) => {
				pinnedAddress = request.address.address
				return new Response('pinned')
			},
		})
		expect(pinnedAddress).toBe('93.184.216.34')
		expect(await response.text()).toBe('pinned')
	})

	test('falls back only to another validated address after a connect-family failure', async () => {
		const attempts: string[] = []
		const response = await safeFetch('https://dual-stack.example/xrpc', {
			resolver: async () => [
				{ address: '2606:4700:4700::1111', family: 6 },
				{ address: '93.184.216.34', family: 4 },
			],
			transport: async (request) => {
				attempts.push(request.address.address)
				if (request.address.family === 6) {
					const error = new Error('IPv6 route unavailable') as Error & { code: string }
					error.code = 'ENETUNREACH'
					throw error
				}
				return new Response('ipv4')
			},
		})
		expect(attempts).toEqual(['2606:4700:4700::1111', '93.184.216.34'])
		expect(await response.text()).toBe('ipv4')
	})

	test('cancels a non-success response body before raising an HTTP error', async () => {
		let cancelled = false
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true
			},
		})
		await expect(
			safeFetchJson('https://pds.example/xrpc', {
				resolver: publicResolver,
				transport: async () => new Response(body, { status: 500 }),
			}),
		).rejects.toThrow('HTTP 500')
		expect(cancelled).toBe(true)
	})

	test('aborts an in-flight transport at the configured deadline', async () => {
		await expect(
			safeFetch('https://pds.example/slow', {
				timeout: 20,
				resolver: publicResolver,
				transport: async ({ signal }) =>
					new Promise<Response>((_resolve, reject) => {
						signal.addEventListener('abort', () => reject(signal.reason), { once: true })
					}),
			}),
		).rejects.toThrow('Request timeout after 20ms')
	})

	test('does not retry transient failures unless requested', async () => {
		let attempts = 0
		await expect(
			safeFetch('https://example.com/data', {
				resolver: publicResolver,
				transport: async () => {
					attempts++
					const error = new Error('fetch failed') as Error & { code: string }
					error.code = 'ECONNRESET'
					throw error
				},
			}),
		).rejects.toThrow('fetch failed')
		expect(attempts).toBe(1)
	})

	test('re-resolves redirects and strips credentials before the next hop', async () => {
		const hosts: string[] = []
		let secondHeaders: Headers | undefined
		const response = await safeFetch('https://first.example/start', {
			headers: { Authorization: 'Bearer secret', Cookie: 'session=secret', 'X-Trace': 'kept' },
			resolver: async (hostname) => {
				hosts.push(hostname)
				return [{ address: hostname === 'first.example' ? '93.184.216.34' : '1.1.1.1', family: 4 }]
			},
			transport: async (request) => {
				if (request.url.hostname === 'first.example') {
					return new Response(null, { status: 302, headers: { Location: 'https://second.example/final' } })
				}
				secondHeaders = request.headers
				return new Response('final')
			},
		})

		expect(hosts).toEqual(['first.example', 'second.example'])
		expect(secondHeaders?.get('authorization')).toBeNull()
		expect(secondHeaders?.get('cookie')).toBeNull()
		expect(secondHeaders?.get('x-trace')).toBe('kept')
		expect(await response.text()).toBe('final')
	})

	test('validates a redirect target before connecting to it', async () => {
		let calls = 0
		await expect(
			safeFetch('https://first.example/start', {
				resolver: publicResolver,
				transport: async () => {
					calls++
					return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/admin' } })
				},
			}),
		).rejects.toThrow('Blocked non-public address')
		expect(calls).toBe(1)
	})

	test('enforces the streamed byte cap when Content-Length is absent', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]))
				controller.enqueue(new Uint8Array([4, 5, 6]))
				controller.close()
			},
		})
		const response = await safeFetch('https://pds.example/blob', {
			maxSize: 4,
			resolver: publicResolver,
			transport: async () => new Response(body),
		})
		await expect(response.arrayBuffer()).rejects.toThrow('Response exceeds max size')
	})

	test('rejects numeric loopback aliases before a transport is used', async () => {
		await expect(
			safeFetch('http://127.1/internal', { resolver: publicResolver, transport: okTransport }),
		).rejects.toThrow('Blocked non-public address')
	})

	test('rejects oversized buffered request bodies before DNS or transport', async () => {
		let calls = 0
		const oversizedBodies: RequestInit['body'][] = [
			'x'.repeat(DEFAULT_MAX_REQUEST_BODY_SIZE + 1),
			new Uint8Array(DEFAULT_MAX_REQUEST_BODY_SIZE + 1),
			new Blob([new Uint8Array(DEFAULT_MAX_REQUEST_BODY_SIZE + 1)]),
		]
		for (const body of oversizedBodies) {
			await expect(
				safeFetch('https://pds.example/upload', {
					method: 'POST',
					body,
					resolver: async () => {
						calls++
						return [{ address: '93.184.216.34', family: 4 as const }]
					},
					transport: okTransport,
				}),
			).rejects.toThrow('Request body exceeds max size')
		}
		expect(calls).toBe(0)
	})

	test('accepts a bounded explicit request-body cap', async () => {
		const body = 'x'.repeat(DEFAULT_MAX_REQUEST_BODY_SIZE + 1)
		let sentBody: Uint8Array | string | undefined
		const response = await safeFetch('https://pds.example/upload', {
			method: 'POST',
			body,
			maxRequestBodySize: body.length,
			resolver: publicResolver,
			transport: async (request) => {
				sentBody = request.body
				return new Response('ok')
			},
		})
		expect(sentBody).toBe(body)
		expect(await response.text()).toBe('ok')
	})

	test('returns a typed status error with the compatible HTTP message', async () => {
		const error = await safeFetchJson('https://pds.example/missing', {
			resolver: publicResolver,
			transport: async () => new Response('missing', { status: 404, statusText: 'Not Found' }),
		}).catch((reason: unknown) => reason)
		expect(error).toBeInstanceOf(SafeFetchHttpError)
		expect((error as SafeFetchHttpError).status).toBe(404)
		expect((error as Error).message).toBe('HTTP 404: Not Found')
	})

	test('leaves retryable status responses to the raw response caller', async () => {
		let attempts = 0
		const response = await safeFetch('https://pds.example/raw', {
			retry: true,
			resolver: publicResolver,
			transport: async () => {
				attempts++
				return new Response('retry later', { status: 503 })
			},
		})
		expect(attempts).toBe(1)
		expect(response.status).toBe(503)
		expect(await response.text()).toBe('retry later')
	})

	test('retries retryable JSON and blob status responses across bounded body reads', async () => {
		let jsonAttempts = 0
		const json = await safeFetchJson<{ ok: boolean }>('https://pds.example/json', {
			retry: true,
			resolver: publicResolver,
			transport: async () => {
				jsonAttempts++
				return jsonAttempts === 1
					? new Response('try again', { status: 503, headers: { 'retry-after': '0' } })
					: new Response(JSON.stringify({ ok: true }))
			},
		})
		expect(json).toEqual({ ok: true })
		expect(jsonAttempts).toBe(2)

		let blobAttempts = 0
		const blob = await safeFetchBlob('https://pds.example/blob', {
			retry: true,
			resolver: publicResolver,
			transport: async () => {
				blobAttempts++
				return blobAttempts === 1
					? new Response('try again', { status: 429, headers: { 'retry-after': '0' } })
					: new Response('done')
			},
		})
		expect(new TextDecoder().decode(blob)).toBe('done')
		expect(blobAttempts).toBe(2)
	})

	test('does not retry before an oversized Retry-After delay', async () => {
		let attempts = 0
		const error = await safeFetchJson('https://pds.example/rate-limited', {
			retry: true,
			timeout: 50,
			resolver: publicResolver,
			transport: async () => {
				attempts++
				return new Response('retry later', { status: 429, headers: { 'retry-after': '999' } })
			},
		}).catch((reason: unknown) => reason)
		expect(error).toBeInstanceOf(SafeFetchHttpError)
		expect(attempts).toBe(1)
	})

	test('retries a truncated bounded JSON body only when retry is requested', async () => {
		let attempts = 0
		const value = await safeFetchJson<{ recovered: boolean }>('https://pds.example/truncated', {
			retry: true,
			timeout: 3_000,
			resolver: publicResolver,
			transport: async () => {
				attempts++
				if (attempts > 1) return new Response(JSON.stringify({ recovered: true }))
				const error = new Error('truncated response') as Error & { code: string }
				error.code = 'ECONNRESET'
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.error(error)
						},
					}),
				)
			},
		})
		expect(value).toEqual({ recovered: true })
		expect(attempts).toBe(2)
	})

	test('cancels a failed body before releasing its reader', async () => {
		let cancelled = false
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
			},
			cancel() {
				cancelled = true
			},
		})
		await expect(
			safeFetchJson('https://pds.example/oversized', {
				maxSize: 4,
				resolver: publicResolver,
				transport: async () => new Response(body),
			}),
		).rejects.toThrow('Response exceeds max size')
		expect(cancelled).toBe(true)
	})

	test('preserves the original body failure when cancellation rejects', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
			},
			cancel() {
				return Promise.reject(new Error('cancellation failed'))
			},
		})
		await expect(
			safeFetchJson('https://pds.example/cancel-error', {
				maxSize: 4,
				resolver: publicResolver,
				transport: async () => new Response(body),
			}),
		).rejects.toThrow('Response exceeds max size')
	})

	test('makes retry backoff abortable and does not retry unsafe methods without opt-in', async () => {
		const controller = new AbortController()
		const abort = setTimeout(() => controller.abort(new Error('caller cancelled')), 10)
		try {
			await expect(
				safeFetchJson('https://pds.example/backoff', {
					retry: true,
					signal: controller.signal,
					resolver: publicResolver,
					transport: async () => new Response('retry later', { status: 503, headers: { 'retry-after': '1' } }),
				}),
			).rejects.toThrow('caller cancelled')
		} finally {
			clearTimeout(abort)
		}

		let attempts = 0
		await expect(
			safeFetchJson('https://pds.example/post', {
				method: 'POST',
				body: '{}',
				retry: true,
				resolver: publicResolver,
				transport: async () => {
					attempts++
					const error = new Error('connection reset') as Error & { code: string }
					error.code = 'ECONNRESET'
					throw error
				},
			}),
		).rejects.toThrow('connection reset')
		expect(attempts).toBe(1)
	})

	test('permits an idempotency-key opt-in for an unsafe retry', async () => {
		let attempts = 0
		const value = await safeFetchJson<{ ok: true }>('https://pds.example/post', {
			method: 'POST',
			body: '{}',
			headers: { 'Idempotency-Key': 'request-1' },
			retry: true,
			resolver: publicResolver,
			transport: async () => {
				attempts++
				return attempts === 1
					? new Response('retry later', { status: 503, headers: { 'retry-after': '0' } })
					: new Response(JSON.stringify({ ok: true }))
			},
		})
		expect(value).toEqual({ ok: true })
		expect(attempts).toBe(2)
	})
})
