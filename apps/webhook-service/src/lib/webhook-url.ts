import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'

/** Webhook endpoints must fit in a record and never need an unbounded URL. */
export const MAX_WEBHOOK_URL_LENGTH = 2048
export const MAX_WEBHOOK_REDIRECTS = 5
export const MAX_WEBHOOK_REQUEST_BYTES = 512 * 1024
export const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024
export const MAX_WEBHOOK_TIMEOUT_MS = 30_000

const BLOCKED_WEBHOOK_HOSTS = new Set(['metadata.google.internal'])

export type WebhookUrlErrorKind =
	| 'invalid_url'
	| 'blocked_destination'
	| 'dns'
	| 'timeout'
	| 'network'
	| 'redirect'
	| 'request_too_large'
	| 'response_too_large'

/**
 * An error whose message is deliberately safe to log. In particular it never
 * includes a user supplied URL, redirect Location, DNS answer, or request
 * headers.
 */
export class WebhookUrlError extends Error {
	constructor(
		public readonly kind: WebhookUrlErrorKind,
		message: string,
	) {
		super(message)
		this.name = 'WebhookUrlError'
	}
}

export interface WebhookResolvedAddress {
	address: string
	family: 4 | 6
}

/** Test seam. Production uses the OS resolver and validates every answer. */
export type WebhookResolver = (hostname: string) => Promise<readonly WebhookResolvedAddress[]>

export interface WebhookTransportRequest {
	url: URL
	address: WebhookResolvedAddress
	method: string
	headers: Headers
	body?: string | Uint8Array
	signal: AbortSignal
	timeoutMs: number
}

/**
 * Test seam for a pinned socket transport. A production request always reaches
 * the validated `address`, not a later DNS lookup for `url.hostname`.
 */
export type WebhookTransport = (request: WebhookTransportRequest) => Promise<Response>

export interface SafeWebhookUrlOptions {
	resolver?: WebhookResolver
	/** Bounded DNS validation deadline; defaults to the webhook request deadline. */
	timeoutMs?: number
	/**
	 * Only has an effect with NODE_ENV=development and
	 * WISP_ALLOW_LOCALHOST_FETCH=1. It permits loopback only, never a private
	 * RFC1918 network.
	 */
	allowLoopback?: boolean
}

export type WebhookHeadersInit = Headers | Record<string, string> | Iterable<readonly [string, string]>

export interface PinnedWebhookFetchOptions extends SafeWebhookUrlOptions {
	method?: string
	headers?: WebhookHeadersInit
	body?: string | Uint8Array
	timeoutMs?: number
	maxRedirects?: number
	maxRequestBytes?: number
	maxResponseBytes?: number
	signal?: AbortSignal
	transport?: WebhookTransport
}

function environment(name: string): string | undefined {
	return process.env[name] || (typeof Bun !== 'undefined' ? Bun.env[name] : undefined)
}

/** The development escape hatch is intentionally both opt-in and loopback-only. */
export function isWebhookLoopbackDevelopmentAllowed(): boolean {
	return environment('NODE_ENV') === 'development' && environment('WISP_ALLOW_LOCALHOST_FETCH') === '1'
}

function mayAllowLoopback(requested: boolean | undefined): boolean {
	return requested === true && isWebhookLoopbackDevelopmentAllowed()
}

function normalizeHostname(hostname: string): string {
	return hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

function parseIpv4(address: string): number[] | null {
	const parts = address.split('.')
	if (parts.length !== 4) return null
	const octets = parts.map((part) => {
		if (!/^\d+$/.test(part)) return Number.NaN
		return Number(part)
	})
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null
	return octets
}

function ipv4InCidr(octets: number[], base: readonly number[], prefix: number): boolean {
	let remaining = prefix
	for (let index = 0; index < 4 && remaining > 0; index++) {
		const bits = Math.min(remaining, 8)
		const mask = (0xff << (8 - bits)) & 0xff
		if (((octets[index] ?? 0) & mask) !== ((base[index] ?? 0) & mask)) return false
		remaining -= bits
	}
	return true
}

// IANA special-purpose IPv4 blocks. The policy is allow-list-like: anything
// special, multicast, reserved, documentation, or private is not public.
const IPV4_NON_PUBLIC_CIDRS: ReadonlyArray<readonly [readonly number[], number]> = [
	[[0, 0, 0, 0], 8], // this network / unspecified
	[[10, 0, 0, 0], 8], // RFC1918
	[[100, 64, 0, 0], 10], // carrier-grade NAT
	[[127, 0, 0, 0], 8], // loopback
	[[169, 254, 0, 0], 16], // link-local
	[[172, 16, 0, 0], 12], // RFC1918
	[[192, 0, 0, 0], 24], // IETF protocol assignments
	[[192, 0, 2, 0], 24], // TEST-NET-1
	[[192, 31, 196, 0], 24], // AS112-v4
	[[192, 52, 193, 0], 24], // AMT
	[[192, 88, 99, 0], 24], // deprecated 6to4 relay anycast
	[[192, 168, 0, 0], 16], // RFC1918
	[[192, 175, 48, 0], 24], // AS112 direct delegation
	[[198, 18, 0, 0], 15], // benchmarking
	[[198, 51, 100, 0], 24], // TEST-NET-2
	[[203, 0, 113, 0], 24], // TEST-NET-3
	[[224, 0, 0, 0], 4], // multicast
	[[240, 0, 0, 0], 4], // reserved and broadcast
]

function parseIpv6(address: string): number[] | null {
	let source = address.toLowerCase()
	if (source.includes('%')) return null // scoped addresses are never remote webhook targets

	// Turn a legal dotted IPv4 tail into two words before expanding ::.
	if (source.includes('.')) {
		const separator = source.lastIndexOf(':')
		if (separator < 0) return null
		const ipv4 = parseIpv4(source.slice(separator + 1))
		if (!ipv4) return null
		const firstWord = ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0)
		const secondWord = ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0)
		source = `${source.slice(0, separator)}:${firstWord.toString(16)}:${secondWord.toString(16)}`
	}

	const compressionParts = source.split('::')
	if (compressionParts.length > 2) return null
	const parseWords = (value: string): number[] | null => {
		if (value === '') return []
		const words: number[] = []
		for (const part of value.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(part)) return null
			words.push(Number.parseInt(part, 16))
		}
		return words
	}

	const left = parseWords(compressionParts[0] ?? '')
	const right = parseWords(compressionParts[1] ?? '')
	if (!left || !right) return null
	if (compressionParts.length === 1) return left.length === 8 ? left : null

	const missing = 8 - left.length - right.length
	if (missing < 1) return null
	return [...left, ...Array<number>(missing).fill(0), ...right]
}

function ipv6HasPrefix(words: number[], prefix: readonly number[], prefixLength: number): boolean {
	let remaining = prefixLength
	for (let index = 0; remaining > 0; index++) {
		const bits = Math.min(remaining, 16)
		const mask = (0xffff << (16 - bits)) & 0xffff
		if (((words[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false
		remaining -= bits
	}
	return true
}

function isIpv4MappedIpv6(words: number[]): boolean {
	return words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
}

function isIpv4CompatibleIpv6(words: number[]): boolean {
	return words.slice(0, 6).every((word) => word === 0)
}

function isPublicIpv6(words: number[]): boolean {
	// Do not accidentally turn IPv4 policy into an IPv6 bypass. This covers
	// ::ffff:a.b.c.d and ::a.b.c.d, including dotted and hexadecimal spellings.
	if (isIpv4MappedIpv6(words) || isIpv4CompatibleIpv6(words)) return false

	// Global unicast is 2000::/3. This excludes unspecified, loopback, ULA,
	// link-local, site-local, multicast, IPv4-translated, and NAT64 well-known
	// prefixes before their embedded address can matter.
	if (!ipv6HasPrefix(words, [0x2000], 3)) return false

	const specialPurposeRanges: ReadonlyArray<readonly [readonly number[], number]> = [
		[[0x0064, 0xff9b], 96], // well-known NAT64
		[[0x0064, 0xff9b, 0x0001], 48], // locally assigned NAT64
		[[0x0100], 64], // discard-only
		[[0x0100, 0x0000, 0x0000, 0x0001], 64], // dummy IPv6 prefix
		[[0x2001, 0x0000], 23], // IETF assignments: includes 2001:2 benchmarking, :3 AMT, :4:112 AS112, :10 ORCHID, :20 ORCHIDv2
		[[0x2001, 0x0db8], 32], // documentation
		[[0x2002], 16], // 6to4 embeds IPv4 and is not a safe remote target
		[[0x2620, 0x004f, 0x8000], 48], // AS112 direct delegation
		[[0x3fff], 20], // documentation
		[[0x5f00], 16], // segment-routing special purpose
	]
	return !specialPurposeRanges.some(([prefix, length]) => ipv6HasPrefix(words, prefix, length))
}

/** Returns true only for globally routable, non-special-purpose addresses. */
export function isPublicWebhookIpAddress(address: string): boolean {
	const normalized = normalizeHostname(address)
	const family = isIP(normalized)
	if (family === 4) {
		const octets = parseIpv4(normalized)
		return octets !== null && !IPV4_NON_PUBLIC_CIDRS.some(([base, prefix]) => ipv4InCidr(octets, base, prefix))
	}
	if (family === 6) {
		const words = parseIpv6(normalized)
		return words !== null && isPublicIpv6(words)
	}
	return false
}

function isLoopbackIpAddress(address: string): boolean {
	const normalized = normalizeHostname(address)
	const ipv4 = parseIpv4(normalized)
	if (ipv4) return ipv4[0] === 127

	const words = parseIpv6(normalized)
	if (!words) return false
	if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true
	if (isIpv4MappedIpv6(words)) {
		const mapped = [(words[6] ?? 0) >> 8, (words[6] ?? 0) & 0xff, (words[7] ?? 0) >> 8, (words[7] ?? 0) & 0xff]
		return mapped[0] === 127
	}
	return false
}

function parseWebhookUrl(rawUrl: string, allowLoopback: boolean): URL {
	if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > MAX_WEBHOOK_URL_LENGTH) {
		throw new WebhookUrlError('invalid_url', 'Webhook URL is invalid')
	}

	let parsed: URL
	try {
		parsed = new URL(rawUrl)
	} catch {
		throw new WebhookUrlError('invalid_url', 'Webhook URL is invalid')
	}

	if (!parsed.hostname) throw new WebhookUrlError('invalid_url', 'Webhook URL is invalid')
	if (parsed.username || parsed.password) {
		throw new WebhookUrlError('invalid_url', 'Webhook URL must not contain credentials')
	}

	const hostname = normalizeHostname(parsed.hostname)
	if (BLOCKED_WEBHOOK_HOSTS.has(hostname)) {
		throw new WebhookUrlError('blocked_destination', 'Webhook URL resolves to a private address')
	}
	const isLoopbackHost = hostname === 'localhost' || hostname.endsWith('.localhost') || isLoopbackIpAddress(hostname)
	if (parsed.protocol !== 'https:' && !(allowLoopback && isLoopbackHost && parsed.protocol === 'http:')) {
		throw new WebhookUrlError('invalid_url', 'Webhook URL must use HTTPS')
	}

	if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
		if (!allowLoopback) throw new WebhookUrlError('blocked_destination', 'Webhook URL resolves to a private address')
	} else if (
		isIP(hostname) &&
		!isPublicWebhookIpAddress(hostname) &&
		!(allowLoopback && isLoopbackIpAddress(hostname))
	) {
		throw new WebhookUrlError('blocked_destination', 'Webhook URL resolves to a private address')
	}

	return parsed
}

function validateResolvedAddress(candidate: WebhookResolvedAddress, allowLoopback: boolean): WebhookResolvedAddress {
	if (!candidate || typeof candidate.address !== 'string') {
		throw new WebhookUrlError('dns', 'Webhook DNS resolution failed')
	}
	const address = normalizeHostname(candidate.address)
	const family = isIP(address)
	if ((family !== 4 && family !== 6) || candidate.family !== family) {
		throw new WebhookUrlError('dns', 'Webhook DNS resolution failed')
	}
	if (isPublicWebhookIpAddress(address)) return { address, family }
	if (allowLoopback && isLoopbackIpAddress(address)) return { address, family }
	throw new WebhookUrlError('blocked_destination', 'Webhook URL resolves to a private address')
}

async function defaultResolver(hostname: string): Promise<readonly WebhookResolvedAddress[]> {
	try {
		const answers = await dnsLookup(hostname, { all: true, verbatim: true })
		return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }))
	} catch {
		throw new WebhookUrlError('dns', 'Webhook DNS resolution failed')
	}
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason
	return new WebhookUrlError('timeout', 'Webhook request timed out')
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal))
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(abortError(signal))
		signal.addEventListener('abort', abort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			},
		)
	})
}

function createDeadline(
	timeoutMs: number,
	upstreamSignal: AbortSignal | undefined,
): { signal: AbortSignal; close: () => void } {
	const controller = new AbortController()
	const timeout = setTimeout(
		() => controller.abort(new WebhookUrlError('timeout', 'Webhook request timed out')),
		timeoutMs,
	)
	const forwardAbort = () => controller.abort(upstreamSignal ? abortError(upstreamSignal) : undefined)
	if (upstreamSignal) {
		if (upstreamSignal.aborted) forwardAbort()
		else upstreamSignal.addEventListener('abort', forwardAbort, { once: true })
	}
	return {
		signal: controller.signal,
		close: () => {
			clearTimeout(timeout)
			if (upstreamSignal) upstreamSignal.removeEventListener('abort', forwardAbort)
		},
	}
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	const actual = value ?? fallback
	if (!Number.isSafeInteger(actual) || actual < minimum) {
		throw new WebhookUrlError('invalid_url', 'Webhook request options are invalid')
	}
	return Math.min(actual, maximum)
}

function bodyLength(body: string | Uint8Array | undefined): number {
	if (body === undefined) return 0
	return typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength
}

function responseHeadersFromNode(headers: Record<string, string | string[] | number | undefined>): Headers {
	const result = new Headers()
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value) result.append(name, item)
		} else {
			result.set(name, String(value))
		}
	}
	return result
}

const defaultTransport: WebhookTransport = async ({ url, address, method, headers, body, signal, timeoutMs }) => {
	const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
	const hostname = normalizeHostname(url.hostname)
	const port = url.port ? Number(url.port) : undefined

	return new Promise<Response>((resolve, reject) => {
		let settled = false
		const settleReject = (error: unknown) => {
			if (settled) return
			settled = true
			reject(error)
		}
		const settleResolve = (response: Response) => {
			if (settled) return
			settled = true
			resolve(response)
		}

		const request = requestFn(
			{
				protocol: url.protocol,
				hostname,
				port,
				path: `${url.pathname}${url.search}`,
				method,
				headers: Object.fromEntries(headers.entries()),
				// Disable pooling. The lookup below is the socket connection path, so
				// DNS cannot change after the answer has been validated.
				agent: false,
				servername: url.protocol === 'https:' ? hostname : undefined,
				lookup: (_lookupHost, lookupOptions, callback) => {
					if (lookupOptions.all) callback(null, [{ address: address.address, family: address.family }])
					else callback(null, address.address, address.family)
				},
			},
			(incoming) => {
				const status = incoming.statusCode ?? 502
				const hasBody = status !== 204 && status !== 205 && status !== 304
				const stream = hasBody ? (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>) : null
				if (!hasBody) incoming.resume()

				const cleanupAbort = () => signal.removeEventListener('abort', abortRequest)
				incoming.once('end', cleanupAbort)
				incoming.once('close', cleanupAbort)
				incoming.once('error', cleanupAbort)
				settleResolve(
					new Response(stream, {
						status,
						statusText: incoming.statusMessage,
						headers: responseHeadersFromNode(incoming.headers),
					}),
				)
			},
		)

		const abortRequest = () => request.destroy(abortError(signal))
		if (signal.aborted) abortRequest()
		else signal.addEventListener('abort', abortRequest, { once: true })
		request.once('error', (error) => {
			signal.removeEventListener('abort', abortRequest)
			settleReject(error)
		})
		request.setTimeout(timeoutMs, () => request.destroy(new WebhookUrlError('timeout', 'Webhook request timed out')))
		request.end(body)
	})
}

function contentLengthExceedsLimit(response: Response, maxSize: number): boolean {
	const header = response.headers.get('content-length')
	if (!header || !/^\d+$/.test(header)) return false
	const size = Number(header)
	return !Number.isSafeInteger(size) || size > maxSize
}

function boundedResponse(response: Response, maxSize: number, signal: AbortSignal, close: () => void): Response {
	if (contentLengthExceedsLimit(response, maxSize)) {
		void response.body?.cancel().catch(() => undefined)
		close()
		throw new WebhookUrlError('response_too_large', 'Webhook response is too large')
	}
	if (!response.body) {
		close()
		return response
	}

	const reader = response.body.getReader()
	let total = 0
	let finished = false
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
	const finish = () => {
		if (finished) return
		finished = true
		signal.removeEventListener('abort', abort)
		close()
	}
	const abort = () => {
		void reader.cancel(signal.reason).catch(() => undefined)
		streamController?.error(abortError(signal))
		finish()
	}
	signal.addEventListener('abort', abort, { once: true })

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller
			if (signal.aborted) abort()
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read()
				if (done) {
					controller.close()
					finish()
					return
				}
				const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
				total += bytes.byteLength
				if (total > maxSize) {
					await reader.cancel()
					throw new WebhookUrlError('response_too_large', 'Webhook response is too large')
				}
				controller.enqueue(bytes)
			} catch (error) {
				controller.error(error)
				finish()
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason)
			} finally {
				finish()
			}
		},
	})
	return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function isConnectFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	const code = (error as Error & { code?: string }).code
	return Boolean(code && ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(code))
}

function safeTransportError(error: unknown): WebhookUrlError {
	if (error instanceof WebhookUrlError) return error
	if (error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('timeout'))) {
		return new WebhookUrlError('timeout', 'Webhook request timed out')
	}
	return new WebhookUrlError('network', 'Webhook request failed')
}

function initialHeaders(headersInit: WebhookHeadersInit | undefined, body: string | Uint8Array | undefined): Headers {
	const headers = new Headers()
	if (headersInit instanceof Headers) {
		for (const [name, value] of headersInit) headers.set(name, value)
	} else if (headersInit && Symbol.iterator in Object(headersInit)) {
		for (const [name, value] of headersInit as Iterable<readonly [string, string]>) headers.set(name, value)
	} else if (headersInit) {
		for (const [name, value] of Object.entries(headersInit)) headers.set(name, value)
	}
	headers.delete('host')
	headers.delete('content-length')
	if (body !== undefined) headers.set('content-length', String(bodyLength(body)))
	return headers
}

function redirectHeaders(headers: Headers): Headers {
	const result = new Headers(headers)
	// A redirect target is a separate trust boundary. Never forward headers that
	// can authenticate us or reveal a signing secret, even to same-origin URLs.
	for (const [name] of [...result]) {
		if (/^(authorization|cookie|proxy-authorization|host|x-webhook-signature|x-api-key)$/i.test(name)) {
			result.delete(name)
		}
	}
	return result
}

async function resolveSafeWebhookUrl(
	url: URL,
	resolver: WebhookResolver,
	allowLoopback: boolean,
	signal: AbortSignal,
): Promise<WebhookResolvedAddress[]> {
	const hostname = normalizeHostname(url.hostname)
	const loopbackHostname = hostname === 'localhost' || hostname.endsWith('.localhost') || isLoopbackIpAddress(hostname)
	let addresses: readonly WebhookResolvedAddress[]
	if (isIP(hostname) === 4 || isIP(hostname) === 6) {
		addresses = [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
	} else {
		try {
			addresses = await waitForAbort(resolver(hostname), signal)
		} catch (error) {
			if (error instanceof WebhookUrlError) throw error
			throw new WebhookUrlError('dns', 'Webhook DNS resolution failed')
		}
	}
	if (addresses.length === 0) throw new WebhookUrlError('dns', 'Webhook DNS resolution failed')

	// All answers must pass. Selecting only a public answer from a mixed answer
	// set still lets an attacker exploit family preference and later rebinding.
	return addresses.map((address) => validateResolvedAddress(address, allowLoopback && loopbackHostname))
}

/**
 * Parse and validate URL syntax only. This is useful while ingesting records;
 * `assertSafeWebhookUrl` additionally resolves every DNS answer.
 */
export function assertSafeWebhookUrlSyntax(url: string, options?: SafeWebhookUrlOptions): void {
	parseWebhookUrl(url, mayAllowLoopback(options?.allowLoopback))
}

/** Resolve every answer and reject any non-public (or mixed) destination. */
export async function assertSafeWebhookUrl(url: string, options?: SafeWebhookUrlOptions): Promise<void> {
	const allowLoopback = mayAllowLoopback(options?.allowLoopback)
	const parsed = parseWebhookUrl(url, allowLoopback)
	const timeoutMs = boundedInteger(options?.timeoutMs, 10_000, 1, MAX_WEBHOOK_TIMEOUT_MS)
	const deadline = createDeadline(timeoutMs, undefined)
	try {
		await resolveSafeWebhookUrl(parsed, options?.resolver ?? defaultResolver, allowLoopback, deadline.signal)
	} finally {
		deadline.close()
	}
}

/**
 * Make a request through a DNS-pinned Node transport. Redirects are followed
 * manually so each Location receives fresh syntax, DNS, and IP validation.
 */
export async function pinnedWebhookFetch(urlText: string, options?: PinnedWebhookFetchOptions): Promise<Response> {
	const timeoutMs = boundedInteger(options?.timeoutMs, 10_000, 1, MAX_WEBHOOK_TIMEOUT_MS)
	const maxRedirects = boundedInteger(options?.maxRedirects, 3, 0, MAX_WEBHOOK_REDIRECTS)
	const maxRequestBytes = boundedInteger(
		options?.maxRequestBytes,
		MAX_WEBHOOK_REQUEST_BYTES,
		0,
		MAX_WEBHOOK_REQUEST_BYTES,
	)
	const maxResponseBytes = boundedInteger(
		options?.maxResponseBytes,
		MAX_WEBHOOK_RESPONSE_BYTES,
		0,
		MAX_WEBHOOK_RESPONSE_BYTES,
	)
	const initialBody = options?.body
	if (bodyLength(initialBody) > maxRequestBytes) {
		throw new WebhookUrlError('request_too_large', 'Webhook request is too large')
	}

	const allowLoopback = mayAllowLoopback(options?.allowLoopback)
	const resolver = options?.resolver ?? defaultResolver
	const transport = options?.transport ?? defaultTransport
	const deadline = createDeadline(timeoutMs, options?.signal)
	const deadlineAt = Date.now() + timeoutMs
	let currentUrl: URL
	try {
		currentUrl = parseWebhookUrl(urlText, allowLoopback)
		let currentHeaders = initialHeaders(options?.headers, initialBody)
		let currentBody = initialBody
		let method = (options?.method ?? 'POST').toUpperCase()
		let redirects = 0

		while (true) {
			const addresses = await resolveSafeWebhookUrl(currentUrl, resolver, allowLoopback, deadline.signal)
			let response: Response | undefined
			let lastConnectFailure: unknown
			for (const [index, address] of addresses.entries()) {
				const remaining = deadlineAt - Date.now()
				if (remaining <= 0) throw new WebhookUrlError('timeout', 'Webhook request timed out')
				const perAddressTimeout = Math.max(1, Math.ceil(remaining / (addresses.length - index)))
				try {
					response = await waitForAbort(
						transport({
							url: currentUrl,
							address,
							method,
							headers: currentHeaders,
							body: currentBody,
							signal: deadline.signal,
							timeoutMs: perAddressTimeout,
						}),
						deadline.signal,
					)
					break
				} catch (error) {
					lastConnectFailure = error
					if (!isConnectFailure(error) || index === addresses.length - 1) throw safeTransportError(error)
				}
			}
			if (!response) throw safeTransportError(lastConnectFailure)

			if (!isRedirectStatus(response.status))
				return boundedResponse(response, maxResponseBytes, deadline.signal, deadline.close)
			const location = response.headers.get('location')
			if (!location) return boundedResponse(response, maxResponseBytes, deadline.signal, deadline.close)
			if (redirects >= maxRedirects) {
				void response.body?.cancel().catch(() => undefined)
				throw new WebhookUrlError('redirect', 'Webhook redirect limit exceeded')
			}

			let nextUrl: URL
			try {
				nextUrl = new URL(location, currentUrl)
			} catch {
				void response.body?.cancel().catch(() => undefined)
				throw new WebhookUrlError('redirect', 'Webhook redirect is invalid')
			}
			void response.body?.cancel().catch(() => undefined)
			currentUrl = parseWebhookUrl(nextUrl.toString(), allowLoopback)
			currentHeaders = redirectHeaders(currentHeaders)
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
				method = 'GET'
				currentBody = undefined
				currentHeaders.delete('content-type')
				currentHeaders.delete('content-length')
			}
			redirects++
		}
	} catch (error) {
		deadline.close()
		throw safeTransportError(error)
	}
}

/** Cancel a response without buffering it. This is the safest webhook response policy. */
export async function discardWebhookResponse(response: Response): Promise<void> {
	try {
		await response.body?.cancel()
	} catch {
		// A peer may have closed the socket while cancellation was in progress.
	}
}
