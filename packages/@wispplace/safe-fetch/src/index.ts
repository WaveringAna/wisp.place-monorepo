/**
 * SSRF-hardened HTTP client.
 *
 * Every hostname is resolved before connecting. All returned A/AAAA answers are
 * checked, then the selected answer is supplied to Node's `lookup` hook. That
 * makes the TCP socket use the checked address instead of doing a second DNS
 * lookup after validation.
 */

import { Buffer } from 'node:buffer'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000
export const DEFAULT_BLOB_FETCH_TIMEOUT_MS = 120_000
export const MAX_FETCH_TIMEOUT_MS = 300_000
export const MAX_REDIRECTS = 5
export const MAX_RESPONSE_SIZE = 10 * 1024 * 1024
export const MAX_JSON_SIZE = 1024 * 1024
export const MAX_BLOB_SIZE = 500 * 1024 * 1024
/** Generic request bodies default to 1 MiB and can never exceed this cap. */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 1024 * 1024
export const MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024

export type SafeFetchErrorKind =
	| 'invalid_url'
	| 'blocked_destination'
	| 'dns'
	| 'timeout'
	| 'redirect'
	| 'request_too_large'
	| 'response_too_large'

/** A classified validation/lifecycle error for callers that need a stable contract. */
export class SafeFetchError extends Error {
	override readonly cause: unknown

	constructor(
		public readonly kind: SafeFetchErrorKind,
		message: string,
		cause?: unknown,
	) {
		super(message)
		this.name = 'SafeFetchError'
		this.cause = cause
		Object.defineProperty(this, 'cause', { enumerable: false })
	}
}

const BLOCKED_HOSTS = new Set(['metadata.google.internal'])
const MAX_RETRIES = 3
const INITIAL_RETRY_DELAY = 1_000
const MAX_RETRY_DELAY = 10_000
const MAX_RETRY_AFTER_MS = 60_000

type AddressFamily = 4 | 6

export interface ResolvedAddress {
	address: string
	family: AddressFamily
}

export type SafeFetchResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>

export interface SafeFetchTransportRequest {
	url: URL
	address: ResolvedAddress
	method: string
	headers: Headers
	body?: Uint8Array | string
	signal: AbortSignal
	timeoutMs: number
}

/**
 * A test seam for deterministic resolver/transport tests. Production callers
 * use the built-in pinned Node transport.
 */
export type SafeFetchTransport = (request: SafeFetchTransportRequest) => Promise<Response>

/** Optional stricter URL policy invoked for the initial URL and every redirect. */
export type SafeFetchUrlValidator = (url: URL) => void

export type SafeFetchRedirectErrorKind = 'invalid' | 'limit'

/** A synchronous shared counter charged before a response chunk is accepted. */
export interface SafeFetchByteBudget {
	consume(bytes: number): void
	/** Optional abort signal exposed by a caller-owned budget. */
	signal?: AbortSignal
}

export interface SafeFetchOptions extends RequestInit {
	maxSize?: number
	/** Cap for a buffered outbound request body. Defaults to 1 MiB. */
	maxRequestBodySize?: number
	timeout?: number
	/** Retry only retryable transport failures for raw responses. */
	retry?: boolean
	/** Explicit opt-in for retrying a non-safe HTTP method. */
	retryUnsafe?: boolean
	maxRedirects?: number
	resolver?: SafeFetchResolver
	transport?: SafeFetchTransport
	/**
	 * Allows only loopback addresses, and only when both NODE_ENV=development
	 * and WISP_ALLOW_LOCALHOST_FETCH=1 are set. It is intentionally not a
	 * general private-network escape hatch.
	 */
	allowLocalhost?: boolean
	/** Apply an additional URL policy to the initial URL and every redirect. */
	urlValidator?: SafeFetchUrlValidator
	/** Additional case-insensitive header names to remove on every redirect. */
	redirectHeadersToStrip?: readonly string[]
	/** Header names to remove when a redirect changes a request to GET. */
	methodChangeHeadersToStrip?: readonly string[]
	/** Customize redirect errors while keeping redirect handling shared. */
	redirectError?: (kind: SafeFetchRedirectErrorKind) => Error
	/** Override the default User-Agent; null disables the default header. */
	defaultUserAgent?: string | null
	/** Customize the error raised when a streamed response exceeds maxSize. */
	responseSizeError?: (maxSize: number) => Error
	/** Customize the error delivered if a returned response body is aborted. */
	responseAbortError?: (signal: AbortSignal) => Error
	/** Charge response bytes to a caller-owned shared transfer budget. */
	byteBudget?: SafeFetchByteBudget
}

function environment(name: string): string | undefined {
	return process.env[name] || (typeof Bun !== 'undefined' ? Bun.env[name] : undefined)
}

/** Explicit, loopback-only development escape hatch. */
export function isLocalhostFetchAllowed(): boolean {
	return environment('NODE_ENV') === 'development' && environment('WISP_ALLOW_LOCALHOST_FETCH') === '1'
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

const IPV4_NON_PUBLIC_CIDRS: ReadonlyArray<readonly [readonly number[], number]> = [
	[[0, 0, 0, 0], 8], // "this" network / unspecified
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
	[[192, 175, 48, 0], 24], // direct delegation AS112 service
	[[198, 18, 0, 0], 15], // benchmarking
	[[198, 51, 100, 0], 24], // TEST-NET-2
	[[203, 0, 113, 0], 24], // TEST-NET-3
	[[224, 0, 0, 0], 4], // multicast
	[[240, 0, 0, 0], 4], // reserved, including limited broadcast
]

function parseIpv6(address: string): number[] | null {
	let source = address.toLowerCase()
	if (source.includes('%')) return null

	// Convert an embedded IPv4 tail into two hexadecimal words first.
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
		const parts = value.split(':')
		const words: number[] = []
		for (const part of parts) {
			if (!/^[0-9a-f]{1,4}$/.test(part)) return null
			words.push(Number.parseInt(part, 16))
		}
		return words
	}

	const left = parseWords(compressionParts[0] ?? '')
	const right = parseWords(compressionParts[1] ?? '')
	if (!left || !right) return null

	if (compressionParts.length === 1) {
		return left.length === 8 ? left : null
	}

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
	// IPv4-compatible and IPv4-mapped forms are never accepted. Even a mapped
	// public IPv4 address is rejected so the policy has one unambiguous address
	// family at the socket boundary.
	if (isIpv4CompatibleIpv6(words) || isIpv4MappedIpv6(words)) return false

	// Public IPv6 unicast is 2000::/3. This also excludes unspecified,
	// loopback, unique-local, link-local, site-local, and multicast ranges.
	if (!ipv6HasPrefix(words, [0x2000], 3)) return false

	const specialPurposeRanges: ReadonlyArray<readonly [readonly number[], number]> = [
		[[0x0064, 0xff9b], 96], // well-known NAT64; can map to a private IPv4 target
		[[0x0064, 0xff9b, 0x0001], 48], // locally assigned NAT64 prefix
		[[0x0100], 64], // discard-only
		[[0x0100, 0x0000, 0x0000, 0x0001], 64], // dummy IPv6 prefix
		// IETF special-purpose umbrella. Its /23 also covers benchmarking
		// (2001:2::/48), AMT (2001:3::/32), AS112 (2001:4:112::/48),
		// ORCHID (2001:10::/28), and ORCHIDv2 (2001:20::/28).
		[[0x2001, 0x0000], 23],
		[[0x2001, 0x0db8], 32], // documentation
		[[0x2002], 16], // 6to4 can embed a non-public IPv4 address
		[[0x2620, 0x004f, 0x8000], 48], // AS112 direct delegation service
		[[0x3fff], 20], // documentation
		[[0x5f00], 16], // segment-routing special purpose
	]

	return !specialPurposeRanges.some(([prefix, length]) => ipv6HasPrefix(words, prefix, length))
}

/** Returns true only for globally routable, non-special-purpose IP addresses. */
export function isPublicIpAddress(address: string): boolean {
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

export function isLoopbackIpAddress(address: string): boolean {
	const normalized = normalizeHostname(address)
	const ipv4 = parseIpv4(normalized)
	if (ipv4) return ipv4[0] === 127

	const ipv6 = parseIpv6(normalized)
	if (!ipv6) return false
	if (ipv6.slice(0, 7).every((word) => word === 0) && ipv6[7] === 1) return true
	if (isIpv4MappedIpv6(ipv6)) {
		const mapped = [(ipv6[6] ?? 0) >> 8, (ipv6[6] ?? 0) & 0xff, (ipv6[7] ?? 0) >> 8, (ipv6[7] ?? 0) & 0xff]
		return mapped[0] === 127
	}
	return false
}

function validateResolvedAddress(candidate: ResolvedAddress, allowLoopback: boolean): ResolvedAddress {
	if (!candidate || typeof candidate.address !== 'string') {
		throw new SafeFetchError('dns', 'DNS returned an invalid address')
	}

	const address = normalizeHostname(candidate.address)
	const detectedFamily = isIP(address)
	if (detectedFamily !== 4 && detectedFamily !== 6) {
		throw new SafeFetchError('dns', `DNS returned a non-IP address: ${candidate.address}`)
	}
	if (candidate.family !== detectedFamily) {
		throw new SafeFetchError('dns', `DNS returned an address-family mismatch for ${candidate.address}`)
	}

	if (isPublicIpAddress(address)) return { address, family: detectedFamily }
	if (allowLoopback && isLoopbackIpAddress(address)) return { address, family: detectedFamily }
	throw new SafeFetchError('blocked_destination', `Blocked non-public address: ${candidate.address}`)
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
	const answers = await dnsLookup(hostname, { all: true, verbatim: true })
	return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }))
}

function validateTimeout(timeout: number | undefined, fallback: number): number {
	const value = timeout ?? fallback
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError('timeout must be a positive finite number')
	}
	return Math.min(Math.floor(value), MAX_FETCH_TIMEOUT_MS)
}

function validateMaxSize(maxSize: number | undefined, fallback: number): number {
	const value = maxSize ?? fallback
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError('maxSize must be a non-negative safe integer')
	}
	return Math.min(value, MAX_BLOB_SIZE)
}

function validateMaxRequestBodySize(maxSize: number | undefined): number {
	const value = maxSize ?? DEFAULT_MAX_REQUEST_BODY_SIZE
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError('maxRequestBodySize must be a non-negative safe integer')
	}
	return Math.min(value, MAX_REQUEST_BODY_SIZE)
}

function validateMaxRedirects(maxRedirects: number | undefined): number {
	const value = maxRedirects ?? MAX_REDIRECTS
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError('maxRedirects must be a non-negative safe integer')
	}
	return Math.min(value, MAX_REDIRECTS)
}

function parseRequestUrl(rawUrl: string, urlValidator?: SafeFetchUrlValidator): URL {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		// Do not echo a raw URL here: callers can put credentials in its query.
		throw new SafeFetchError('invalid_url', 'Invalid URL')
	}

	urlValidator?.(url)
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new SafeFetchError('invalid_url', `Blocked protocol: ${url.protocol}`)
	}
	if (!url.hostname) throw new SafeFetchError('invalid_url', 'URL must contain a hostname')
	if (url.username || url.password) throw new SafeFetchError('invalid_url', 'URLs with credentials are not allowed')
	return url
}

async function resolveAndValidate(
	url: URL,
	resolver: SafeFetchResolver,
	allowLoopback: boolean,
	signal: AbortSignal,
): Promise<ResolvedAddress[]> {
	const hostname = normalizeHostname(url.hostname)
	if (BLOCKED_HOSTS.has(hostname)) throw new SafeFetchError('blocked_destination', `Blocked host: ${hostname}`)
	if (hostname === 'localhost' && !allowLoopback)
		throw new SafeFetchError('blocked_destination', `Blocked host: ${hostname}`)

	const family = isIP(hostname)
	let candidates: readonly ResolvedAddress[]
	if (family === 4 || family === 6) {
		candidates = [{ address: hostname, family }]
	} else {
		try {
			candidates = await waitForAbort(() => resolver(hostname), signal)
		} catch (error) {
			if (signal.aborted) throw abortError(signal)
			if (error instanceof SafeFetchError) throw error
			throw new SafeFetchError('dns', 'DNS resolution failed', error)
		}
	}

	if (candidates.length === 0) throw new SafeFetchError('dns', `DNS returned no addresses for ${hostname}`)

	// The development escape hatch is deliberately hostname-scoped as well as
	// address-scoped. It cannot turn an arbitrary production-style hostname into
	// a private-network fetch.
	const loopbackHostname = hostname === 'localhost' || hostname.endsWith('.localhost') || isLoopbackIpAddress(hostname)
	const mayUseLoopback = allowLoopback && loopbackHostname

	// Validate *every* answer before selecting one. A mixed public/private DNS
	// response is rejected rather than silently selecting the public answer.
	return candidates.map((candidate) => validateResolvedAddress(candidate, mayUseLoopback))
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason
	if (reason instanceof Error) return reason
	return new Error(reason ? String(reason) : 'Request aborted')
}

function waitForAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal))

	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener('abort', abort)
		const abort = () => {
			cleanup()
			reject(abortError(signal))
		}
		signal.addEventListener('abort', abort, { once: true })
		if (signal.aborted) {
			abort()
			return
		}

		let promise: Promise<T>
		try {
			promise = operation()
		} catch (error) {
			cleanup()
			reject(error)
			return
		}
		promise.then(
			(value) => {
				cleanup()
				resolve(value)
			},
			(error) => {
				cleanup()
				reject(error)
			},
		)
	})
}

function createDeadline(
	timeoutMs: number,
	upstreamSignal: AbortSignal | null | undefined,
	secondarySignal?: AbortSignal,
): {
	signal: AbortSignal
	close: () => void
} {
	const controller = new AbortController()
	const timeout = setTimeout(
		() => controller.abort(new SafeFetchError('timeout', `Request timeout after ${timeoutMs}ms`)),
		timeoutMs,
	)
	const signals = [upstreamSignal, secondarySignal].filter(
		(signal): signal is AbortSignal => signal !== undefined && signal !== null,
	)
	const forwardAbort = (signal: AbortSignal) => () => controller.abort(abortError(signal))
	const listeners = signals.map((signal) => ({ signal, abort: forwardAbort(signal) }))

	for (const listener of listeners) {
		if (listener.signal.aborted) controller.abort(abortError(listener.signal))
		else listener.signal.addEventListener('abort', listener.abort, { once: true })
	}

	return {
		signal: controller.signal,
		close: () => {
			clearTimeout(timeout)
			for (const listener of listeners) listener.signal.removeEventListener('abort', listener.abort)
		},
	}
}

function headersForInitialRequest(
	headersInit: RequestInit['headers'] | undefined,
	defaultUserAgent: string | null | undefined,
): Headers {
	const headers = new Headers(headersInit)
	headers.delete('host')
	if (defaultUserAgent !== null && !headers.has('user-agent')) {
		headers.set('user-agent', defaultUserAgent ?? 'wisp-place hosting-service')
	}
	return headers
}

function headersForRedirect(headers: Headers, additionalHeaders: readonly string[] | undefined): Headers {
	const next = new Headers(headers)
	// Do not carry credentials to a redirect, including a same-origin redirect.
	// Node has no cookie jar, so this also prevents implicit cookie forwarding.
	for (const name of ['authorization', 'cookie', 'proxy-authorization', 'host', ...(additionalHeaders ?? [])]) {
		next.delete(name)
	}
	return next
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
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

function requestBodyTooLarge(maxSize: number): Error {
	return new SafeFetchError('request_too_large', `Request body exceeds max size: ${maxSize} bytes`)
}

function assertRequestBodySize(size: number, maxSize: number): void {
	if (!Number.isSafeInteger(size) || size < 0 || size > maxSize) throw requestBodyTooLarge(maxSize)
}

function assertUrlSearchParamsCanFit(body: URLSearchParams, maxSize: number): void {
	let upperBound = 0
	for (const [name, value] of body) {
		// application/x-www-form-urlencoded percent encodes at most three ASCII
		// bytes per UTF-8 byte. Reject before materializing an oversized string.
		upperBound += Buffer.byteLength(name, 'utf8') * 3 + Buffer.byteLength(value, 'utf8') * 3 + 2
		if (!Number.isSafeInteger(upperBound) || upperBound > maxSize) throw requestBodyTooLarge(maxSize)
	}
}

async function serializeBody(body: RequestInit['body'], maxSize: number): Promise<Uint8Array | string | undefined> {
	if (body === undefined || body === null) return undefined
	if (typeof body === 'string') {
		assertRequestBodySize(Buffer.byteLength(body, 'utf8'), maxSize)
		return body
	}
	if (body instanceof URLSearchParams) {
		assertUrlSearchParamsCanFit(body, maxSize)
		const serialized = body.toString()
		assertRequestBodySize(Buffer.byteLength(serialized, 'utf8'), maxSize)
		return serialized
	}
	if (body instanceof Blob) {
		assertRequestBodySize(body.size, maxSize)
		return new Uint8Array(await body.arrayBuffer())
	}
	if (body instanceof ArrayBuffer) {
		assertRequestBodySize(body.byteLength, maxSize)
		return new Uint8Array(body)
	}
	if (ArrayBuffer.isView(body)) {
		assertRequestBodySize(body.byteLength, maxSize)
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
	}
	throw new Error('safeFetch only supports buffered request bodies')
}

const defaultTransport: SafeFetchTransport = async ({ url, address, method, headers, body, signal, timeoutMs }) => {
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
				// Do not pool sockets across DNS validations. The lookup callback is
				// the actual connection path and returns the address just validated.
				agent: false,
				servername: url.protocol === 'https:' ? hostname : undefined,
				lookup: (_lookupHost, lookupOptions, callback) => {
					// Bun can attempt the socket synchronously when a custom lookup
					// callback resolves inline. Defer the pinned answer so the request's
					// error listener is installed before an immediate refusal is emitted.
					queueMicrotask(() => {
						if (lookupOptions.all) {
							callback(null, [{ address: address.address, family: address.family }])
						} else {
							callback(null, address.address, address.family)
						}
					})
				},
			},
			(incoming) => {
				const status = incoming.statusCode ?? 502
				const hasBody = status !== 204 && status !== 205 && status !== 304
				const bodyStream = hasBody ? (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>) : null
				if (!hasBody) incoming.resume()

				const cleanupAbort = () => signal.removeEventListener('abort', abortRequest)
				incoming.once('end', cleanupAbort)
				incoming.once('close', cleanupAbort)
				incoming.once('error', cleanupAbort)

				settleResolve(
					new Response(bodyStream, {
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

		// Keep this listener for the request lifetime. A transport can emit a
		// second error after a refusal or abort; it must never become process-fatal.
		request.on('error', (error) => {
			signal.removeEventListener('abort', abortRequest)
			settleReject(error)
		})
		request.setTimeout(timeoutMs, () => {
			const error = new Error(`Request timeout after ${timeoutMs}ms`) as Error & { code?: string }
			error.code = 'ETIMEDOUT'
			request.destroy(error)
		})
		request.end(body)
	})
}

function contentLengthExceedsLimit(response: Response, maxSize: number): boolean {
	const value = response.headers.get('content-length')
	if (!value || !/^\d+$/.test(value)) return false
	const length = Number(value)
	return !Number.isSafeInteger(length) || length > maxSize
}

function cancelReader(reader: { cancel(reason?: unknown): Promise<unknown> }, reason?: unknown): void {
	// Start cancellation before releasing the lock, but never let a peer that
	// stalls, rejects, or synchronously throws during cancellation mask the
	// original size/read failure.
	try {
		void reader.cancel(reason).catch(() => undefined)
	} catch {
		// Preserve the triggering failure.
	}
}

function withBoundedBody(
	response: Response,
	maxSize: number,
	signal: AbortSignal,
	close: () => void,
	byteBudget?: SafeFetchByteBudget,
	responseSizeError?: (maxSize: number) => Error,
	responseAbortError?: (signal: AbortSignal) => Error,
): Response {
	if (contentLengthExceedsLimit(response, maxSize)) {
		if (response.body) cancelReader(response.body)
		close()
		throw (
			responseSizeError?.(maxSize) ??
			new SafeFetchError('response_too_large', `Response too large: content-length exceeds ${maxSize} bytes`)
		)
	}
	if (!response.body) {
		close()
		return response
	}

	const reader = response.body.getReader()
	let totalSize = 0
	let closed = false
	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined

	const finish = () => {
		if (closed) return
		closed = true
		signal.removeEventListener('abort', abortBody)
		close()
	}
	const abortBody = () => {
		cancelReader(reader, signal.reason)
		streamController?.error(responseAbortError?.(signal) ?? abortError(signal))
		finish()
	}
	signal.addEventListener('abort', abortBody, { once: true })

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller
			if (signal.aborted) abortBody()
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read()
				if (done) {
					controller.close()
					finish()
					return
				}

				const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
				// Charge before enqueueing. A budget failure aborts the request signal
				// and the catch path cancels the underlying reader/socket.
				byteBudget?.consume(chunk.byteLength)
				totalSize += chunk.byteLength
				if (totalSize > maxSize) {
					const error =
						responseSizeError?.(maxSize) ??
						new SafeFetchError('response_too_large', `Response exceeds max size: ${maxSize} bytes`)
					cancelReader(reader, error)
					throw error
				}
				controller.enqueue(chunk)
			} catch (error) {
				cancelReader(reader, error)
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

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

function isConnectFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	const code = (error as Error & { code?: string }).code
	return Boolean(code && ['ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(code))
}

function retryAfterMilliseconds(value: string | null): number | undefined {
	if (!value) return undefined
	if (/^\d+$/.test(value)) {
		const milliseconds = Number(value) * 1000
		return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
	}
	const timestamp = Date.parse(value)
	return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined
}

/** HTTP status failure returned by safeFetchJson/safeFetchBlob. */
export class SafeFetchHttpError extends Error {
	readonly status: number
	readonly statusText: string
	readonly retryAfterMs: number | undefined

	constructor(response: Response) {
		super(`HTTP ${response.status}: ${response.statusText}`)
		this.name = 'SafeFetchHttpError'
		this.status = response.status
		this.statusText = response.statusText
		this.retryAfterMs = retryAfterMilliseconds(response.headers.get('retry-after'))
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

function isRetryableError(error: unknown): boolean {
	if (error instanceof SafeFetchHttpError) return isRetryableStatus(error.status)
	if (error instanceof SafeFetchError && error.kind === 'dns' && error.cause !== undefined) {
		return isRetryableError(error.cause)
	}
	if (!(error instanceof Error)) return false
	const code = (error as Error & { code?: string }).code
	if (
		code &&
		[
			'ECONNRESET',
			'ECONNREFUSED',
			'ETIMEDOUT',
			'ENOTFOUND',
			'ENETUNREACH',
			'EAI_AGAIN',
			'EPIPE',
			'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
			'ERR_SSL_WRONG_VERSION_NUMBER',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		].includes(code)
	) {
		return true
	}
	return error.name === 'AbortError' || error.message.includes('timeout') || error.message.includes('fetch failed')
}

function retryDelay(error: unknown, attempt: number): number | undefined {
	if (error instanceof SafeFetchHttpError && error.retryAfterMs !== undefined) {
		// Do not turn a long Retry-After into an earlier retry. It is only useful
		// when the server's requested delay fits our hard cap and total deadline.
		return error.retryAfterMs <= MAX_RETRY_AFTER_MS ? error.retryAfterMs : undefined
	}
	return Math.min(INITIAL_RETRY_DELAY * 2 ** attempt, MAX_RETRY_DELAY)
}

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(abortError(signal))
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener('abort', abort)
			resolve()
		}, milliseconds)
		const abort = () => {
			clearTimeout(timeout)
			reject(abortError(signal))
		}
		signal.addEventListener('abort', abort, { once: true })
	})
}

async function withRetry<T>(
	request: (remainingTimeoutMs: number) => Promise<T>,
	context: string,
	totalTimeoutMs: number,
	upstreamSignal: AbortSignal | null | undefined,
	secondarySignal?: AbortSignal,
): Promise<T> {
	const requestDeadline = createDeadline(totalTimeoutMs, upstreamSignal, secondarySignal)
	const deadlineAt = Date.now() + totalTimeoutMs
	let lastError: unknown
	try {
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			const remainingTimeoutMs = deadlineAt - Date.now()
			if (remainingTimeoutMs <= 0) throw new SafeFetchError('timeout', `Request timeout after ${totalTimeoutMs}ms`)
			if (requestDeadline.signal.aborted) throw abortError(requestDeadline.signal)
			try {
				return await request(remainingTimeoutMs)
			} catch (error) {
				lastError = error
				if (requestDeadline.signal.aborted) throw abortError(requestDeadline.signal)
				if (attempt === MAX_RETRIES || !isRetryableError(error)) throw error
				const delay = retryDelay(error, attempt)
				if (delay === undefined || delay >= deadlineAt - Date.now()) throw error
				// This message intentionally contains no URL, request body, or remote error.
				console.warn(`${context} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}); retrying in ${delay}ms`)
				await sleepWithAbort(delay, requestDeadline.signal)
			}
		}
		throw lastError
	} finally {
		requestDeadline.close()
	}
}

function isSafeRetryMethod(method: string): boolean {
	return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
}

function canRetry(options: SafeFetchOptions | undefined): boolean {
	if (options?.retry !== true) return false
	const method = (options.method || 'GET').toUpperCase()
	if (isSafeRetryMethod(method)) return true
	return options.retryUnsafe === true || new Headers(options.headers).has('idempotency-key')
}

async function fetchOnce(
	urlText: string,
	options: SafeFetchOptions | undefined,
	remainingTimeoutMs?: number,
): Promise<Response> {
	const configuredTimeoutMs = validateTimeout(options?.timeout, DEFAULT_FETCH_TIMEOUT_MS)
	const timeoutMs =
		remainingTimeoutMs === undefined ? configuredTimeoutMs : Math.min(configuredTimeoutMs, remainingTimeoutMs)
	if (timeoutMs <= 0) throw new SafeFetchError('timeout', `Request timeout after ${configuredTimeoutMs}ms`)
	const maxSize = validateMaxSize(options?.maxSize, MAX_RESPONSE_SIZE)
	const maxRequestBodySize = validateMaxRequestBodySize(options?.maxRequestBodySize)
	const maxRedirects = validateMaxRedirects(options?.maxRedirects)
	const allowLoopback = options?.allowLocalhost === true && isLocalhostFetchAllowed()
	const resolver = options?.resolver ?? defaultResolver
	const transport = options?.transport ?? defaultTransport
	const deadlineAt = Date.now() + timeoutMs
	const deadline = createDeadline(timeoutMs, options?.signal, options?.byteBudget?.signal)

	try {
		let currentUrl = parseRequestUrl(urlText, options?.urlValidator)
		let currentHeaders = headersForInitialRequest(options?.headers, options?.defaultUserAgent)
		let method = (options?.method || 'GET').toUpperCase()
		let body = await waitForAbort(() => serializeBody(options?.body, maxRequestBodySize), deadline.signal)
		let redirects = 0

		while (true) {
			const addresses = await resolveAndValidate(currentUrl, resolver, allowLoopback, deadline.signal)
			let response: Response | undefined
			let lastConnectError: unknown

			// A dual-stack name may have an unreachable first family. Each address
			// was validated above, so retrying a connect failure only across this
			// list preserves the DNS-rebinding guarantee.
			for (const [index, address] of addresses.entries()) {
				const remainingForConnection = deadlineAt - Date.now()
				if (remainingForConnection <= 0) throw new SafeFetchError('timeout', `Request timeout after ${timeoutMs}ms`)
				// Reserve time for later validated families instead of letting an
				// unreachable first address consume the whole request deadline.
				const addressesRemaining = addresses.length - index
				const attemptTimeoutMs = Math.max(1, Math.ceil(remainingForConnection / addressesRemaining))
				try {
					response = await waitForAbort(
						() =>
							transport({
								url: currentUrl,
								address,
								method,
								headers: currentHeaders,
								body,
								signal: deadline.signal,
								timeoutMs: attemptTimeoutMs,
							}),
						deadline.signal,
					)
					break
				} catch (error) {
					lastConnectError = error
					if (!isConnectFailure(error) || index === addresses.length - 1) throw error
				}
			}
			if (!response) throw lastConnectError

			if (!isRedirectStatus(response.status)) {
				return withBoundedBody(
					response,
					maxSize,
					deadline.signal,
					deadline.close,
					options?.byteBudget,
					options?.responseSizeError,
					options?.responseAbortError,
				)
			}

			if (options?.redirect === 'manual') {
				return withBoundedBody(
					response,
					maxSize,
					deadline.signal,
					deadline.close,
					options?.byteBudget,
					options?.responseSizeError,
					options?.responseAbortError,
				)
			}
			if (options?.redirect === 'error') {
				if (response.body) cancelReader(response.body)
				throw new SafeFetchError('redirect', `Redirect blocked: HTTP ${response.status}`)
			}

			const location = response.headers.get('location')
			if (!location)
				return withBoundedBody(
					response,
					maxSize,
					deadline.signal,
					deadline.close,
					options?.byteBudget,
					options?.responseSizeError,
					options?.responseAbortError,
				)
			if (redirects >= maxRedirects) {
				if (response.body) cancelReader(response.body)
				throw (
					options?.redirectError?.('limit') ??
					new SafeFetchError('redirect', `Too many redirects (maximum ${maxRedirects})`)
				)
			}

			let nextUrl: URL
			try {
				nextUrl = new URL(location, currentUrl)
			} catch {
				if (response.body) cancelReader(response.body)
				throw (
					options?.redirectError?.('invalid') ??
					new SafeFetchError('redirect', 'Redirect contained an invalid Location URL')
				)
			}
			if (response.body) cancelReader(response.body)
			currentUrl = parseRequestUrl(nextUrl.toString(), options?.urlValidator)

			currentHeaders = headersForRedirect(currentHeaders, options?.redirectHeadersToStrip)
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
				method = 'GET'
				body = undefined
				for (const name of options?.methodChangeHeadersToStrip ?? []) currentHeaders.delete(name)
			}
			redirects++
		}
	} catch (error) {
		deadline.close()
		throw error
	}
}

export async function safeFetch(url: string, options?: SafeFetchOptions): Promise<Response> {
	if (canRetry(options)) {
		const totalTimeoutMs = validateTimeout(options?.timeout, DEFAULT_FETCH_TIMEOUT_MS)
		return withRetry(
			(remainingTimeoutMs) => fetchOnce(url, { ...options, retry: false }, remainingTimeoutMs),
			'Fetch',
			totalTimeoutMs,
			options?.signal,
			options?.byteBudget?.signal,
		)
	}
	return fetchOnce(url, options)
}

function cancelResponseBody(response: Response): void {
	// A hostile stream must not delay returning its typed status error.
	try {
		void response.body?.cancel().catch(() => undefined)
	} catch {
		// Preserve the typed status error.
	}
}

async function readBoundedBody(
	response: Response,
	maxSize: number,
	label: string,
	byteBudget?: SafeFetchByteBudget,
): Promise<Uint8Array> {
	if (!response.ok) {
		const error = new SafeFetchHttpError(response)
		cancelResponseBody(response)
		throw error
	}
	const reader = response.body?.getReader()
	if (!reader) throw new Error('No response body')

	const chunks: Uint8Array[] = []
	let totalSize = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			byteBudget?.consume(value.byteLength)
			totalSize += value.byteLength
			if (totalSize > maxSize) throw new Error(`${label} exceeds max size: ${maxSize} bytes`)
			chunks.push(value)
		}
	} catch (error) {
		// Releasing a reader does not cancel its source. Cancel before releasing so
		// a failed size/read path cannot leave a socket or body stream running.
		cancelReader(reader, error)
		throw error
	} finally {
		reader.releaseLock()
	}

	const output = new Uint8Array(totalSize)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.byteLength
	}
	return output
}

async function fetchAndReadWithRetry<T>(
	url: string,
	options: SafeFetchOptions | undefined,
	maxSize: number,
	timeout: number,
	read: (response: Response) => Promise<T>,
): Promise<T> {
	const attemptOptions: SafeFetchOptions = { ...options, maxSize, timeout, retry: false }
	if (!canRetry(options)) {
		return read(await fetchOnce(url, attemptOptions))
	}

	// Do not call safeFetch here: it can only retry before headers because it
	// returns a stream. This wrapper owns both the request and bounded body read.
	return withRetry(
		async (remainingTimeoutMs) => read(await fetchOnce(url, attemptOptions, remainingTimeoutMs)),
		'Fetch',
		timeout,
		options?.signal,
		options?.byteBudget?.signal,
	)
}

export async function safeFetchJson<T = unknown>(url: string, options?: SafeFetchOptions): Promise<T> {
	const maxSize = validateMaxSize(options?.maxSize, MAX_JSON_SIZE)
	const timeout = validateTimeout(options?.timeout, DEFAULT_FETCH_TIMEOUT_MS)
	return fetchAndReadWithRetry(url, options, maxSize, timeout, async (response) => {
		const bytes = await readBoundedBody(response, maxSize, 'Response', options?.byteBudget)
		return JSON.parse(new TextDecoder().decode(bytes)) as T
	})
}

export async function safeFetchBlob(url: string, options?: SafeFetchOptions): Promise<Uint8Array> {
	const maxSize = validateMaxSize(options?.maxSize, MAX_BLOB_SIZE)
	const timeout = validateTimeout(options?.timeout, DEFAULT_BLOB_FETCH_TIMEOUT_MS)
	return fetchAndReadWithRetry(url, options, maxSize, timeout, (response) =>
		readBoundedBody(response, maxSize, 'Blob', options?.byteBudget),
	)
}
