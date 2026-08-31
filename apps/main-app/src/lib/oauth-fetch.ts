/**
 * OAuth fetch transport with an explicit development-only compose rewrite.
 *
 * OAuth metadata, PAR, token, and session requests can all target URLs supplied
 * by a remote authorization server. They therefore must not use the ambient
 * fetch implementation: DNS answers are checked before every connection and
 * the selected answer is pinned through Node's lookup hook.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import {
	type IdentityResolvedAddress,
	isIdentityLoopbackDevelopmentAllowed,
	isPublicIdentityAddress,
} from '@wispplace/atproto-utils'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_URL_LENGTH = 8192
const MAX_REDIRECTS = 5
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_REQUEST_BYTES = 1024 * 1024
const BLOCKED_HOSTS = new Set(['metadata.google.internal'])
const CONNECT_FAILURES = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'ENETUNREACH',
	'EHOSTUNREACH',
	'EADDRNOTAVAIL',
])

type AddressFamily = 4 | 6

type OAuthDnsResolver = (hostname: string) => Promise<readonly IdentityResolvedAddress[]>

type OAuthTransportRequest = {
	url: URL
	address: IdentityResolvedAddress
	method: string
	headers: Headers
	body?: Uint8Array
	signal: AbortSignal
	timeoutMs: number
}

type OAuthTransport = (request: OAuthTransportRequest) => Promise<Response>

export interface OAuthFetchOptions {
	rewriteFrom?: string
	rewriteTo?: string
	/** Explicit local-development HTTP opt-in. Production always stays HTTPS. */
	allowHttp?: boolean
	/** Deterministic seams for transport tests. They still pass address validation. */
	resolver?: OAuthDnsResolver
	transport?: OAuthTransport
}

function environment(name: string): string | undefined {
	return process.env[name] || (typeof Bun !== 'undefined' ? Bun.env[name] : undefined)
}

function localDevelopment(): boolean {
	return environment('LOCAL_DEV') === 'true'
}

function normalizeHostname(value: string): string {
	return value.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

function isLoopbackAddress(value: string): boolean {
	const address = normalizeHostname(value)
	if (isIP(address) === 4) return address.startsWith('127.')
	if (isIP(address) !== 6) return false
	if (address === '::1') return true
	const groups = address.split(':')
	return groups.length === 8 && groups.slice(0, 7).every((group) => group === '0') && groups[7] === '1'
}

function isLoopbackHostname(value: string): boolean {
	const host = normalizeHostname(value)
	return host === 'localhost' || host.endsWith('.localhost') || isLoopbackAddress(host)
}

function parseRequestUrl(raw: string, allowHttp: boolean): URL {
	if (raw.length > MAX_URL_LENGTH) throw new Error('OAuth request URL is too long')
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new Error('OAuth request URL is invalid')
	}
	if (!url.hostname || url.username || url.password || url.hash) throw new Error('OAuth request URL is invalid')
	if (url.protocol === 'https:') return url
	if (url.protocol === 'http:' && allowHttp) return url
	throw new Error('OAuth requests require HTTPS')
}

function validateAddress(candidate: IdentityResolvedAddress, allowLoopback: boolean): IdentityResolvedAddress {
	if (!candidate || typeof candidate.address !== 'string' || (candidate.family !== 4 && candidate.family !== 6)) {
		throw new Error('OAuth DNS answer is invalid')
	}
	const address = normalizeHostname(candidate.address)
	if (isIP(address) !== candidate.family) throw new Error('OAuth DNS address family is invalid')
	if (!isPublicIdentityAddress(address) && !(allowLoopback && isLoopbackAddress(address))) {
		throw new Error('OAuth DNS answer is not public')
	}
	return { address, family: candidate.family }
}

const systemResolver: OAuthDnsResolver = async (hostname) => {
	const answers = await dnsLookup(hostname, { all: true, verbatim: true })
	return answers.flatMap((answer) =>
		answer.family === 4 || answer.family === 6
			? [{ address: answer.address, family: answer.family as AddressFamily }]
			: [],
	)
}

async function resolveAddresses(
	url: URL,
	resolver: OAuthDnsResolver,
	allowLoopback: boolean,
): Promise<IdentityResolvedAddress[]> {
	const host = normalizeHostname(url.hostname)
	if (BLOCKED_HOSTS.has(host)) throw new Error('OAuth destination is blocked')
	const family = isIP(host)
	const addresses =
		family === 4 || family === 6 ? [{ address: host, family: family as AddressFamily }] : await resolver(host)
	if (!addresses.length) throw new Error('OAuth DNS returned no addresses')

	const localHost = isLoopbackHostname(host)
	const checked = addresses.map((address) => validateAddress(address, allowLoopback && localHost))
	// A local development name is only safe when every answer is loopback. This
	// prevents a poisoned localhost DNS answer from selecting a public endpoint.
	if (localHost && checked.some((address) => !isLoopbackAddress(address.address))) {
		throw new Error('OAuth localhost DNS answers are mixed')
	}
	return checked
}

function abortError(signal: AbortSignal): Error {
	const reason = signal.reason
	if (reason instanceof Error) return reason
	return new Error(reason ? String(reason) : 'OAuth request aborted')
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
			(error) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			},
		)
	})
}

function deadline(
	timeoutMs: number,
	upstream: AbortSignal | null | undefined,
): {
	signal: AbortSignal
	close: () => void
} {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new Error('OAuth request timed out')), timeoutMs)
	const forwardAbort = () => controller.abort(upstream?.reason)
	if (upstream) {
		if (upstream.aborted) forwardAbort()
		else upstream.addEventListener('abort', forwardAbort, { once: true })
	}
	return {
		signal: controller.signal,
		close: () => {
			clearTimeout(timer)
			upstream?.removeEventListener('abort', forwardAbort)
		},
	}
}

function headersFromNode(values: Record<string, string | string[] | undefined>): Headers {
	const headers = new Headers()
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item)
		} else {
			headers.set(name, value)
		}
	}
	return headers
}

const nodeTransport: OAuthTransport = async ({ url, address, method, headers, body, signal, timeoutMs }) => {
	const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
	return new Promise<Response>((resolve, reject) => {
		let settled = false
		const resolveOnce = (response: Response) => {
			if (settled) return
			settled = true
			resolve(response)
		}
		const rejectOnce = (error: unknown) => {
			if (settled) return
			settled = true
			reject(error)
		}

		const request = requestFn(
			{
				protocol: url.protocol,
				hostname: normalizeHostname(url.hostname),
				port: url.port ? Number(url.port) : undefined,
				path: `${url.pathname}${url.search}`,
				method,
				headers: Object.fromEntries(headers.entries()),
				agent: false,
				servername:
					url.protocol === 'https:' && isIP(normalizeHostname(url.hostname)) === 0
						? normalizeHostname(url.hostname)
						: undefined,
				lookup: (_hostname, lookupOptions, callback) =>
					lookupOptions.all
						? callback(null, [{ address: address.address, family: address.family }])
						: callback(null, address.address, address.family),
			},
			(response) => {
				const status = response.statusCode ?? 502
				if (status < 200 || status > 599) {
					response.resume()
					rejectOnce(new Error('OAuth response status is invalid'))
					return
				}
				const cleanupAbort = () => signal.removeEventListener('abort', abort)
				response.once('end', cleanupAbort)
				response.once('close', cleanupAbort)
				response.once('error', cleanupAbort)
				const hasBody = ![204, 205, 304].includes(response.statusCode ?? 0)
				if (!hasBody) response.resume()
				resolveOnce(
					new Response(hasBody ? (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>) : null, {
						status: response.statusCode ?? 502,
						statusText: response.statusMessage,
						headers: headersFromNode(response.headers),
					}),
				)
			},
		)
		const abort = () => request.destroy(abortError(signal))
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
		request.once('error', (error) => {
			signal.removeEventListener('abort', abort)
			rejectOnce(error)
		})
		request.setTimeout(timeoutMs, () => request.destroy(new Error('OAuth request timed out')))
		request.end(body)
	})
}

function responseTooLarge(response: Response, maxBytes: number): boolean {
	const value = response.headers.get('content-length')
	return value !== null && /^\d+$/.test(value) && Number(value) > maxBytes
}

function cancelResponse(response: Response): void {
	try {
		void response.body?.cancel().catch(() => undefined)
	} catch {
		// The peer may have already closed the body.
	}
}

function cancelReader(reader: { cancel(reason?: unknown): Promise<unknown> }, reason: unknown): void {
	try {
		void reader.cancel(reason).catch(() => undefined)
	} catch {
		// Preserve the original read or size error.
	}
}

async function readBoundedResponse(response: Response, maxBytes: number, signal: AbortSignal): Promise<Response> {
	if (responseTooLarge(response, maxBytes)) {
		cancelResponse(response)
		throw new Error('OAuth response exceeds size limit')
	}
	if (!response.body) return response
	const reader = response.body.getReader()
	const parts: Uint8Array[] = []
	let size = 0
	try {
		while (true) {
			const next = await waitForAbort(reader.read(), signal)
			if (next.done) break
			size += next.value.byteLength
			if (size > maxBytes) throw new Error('OAuth response exceeds size limit')
			parts.push(next.value)
		}
	} catch (error) {
		cancelReader(reader, error)
		throw error
	} finally {
		reader.releaseLock()
	}
	const body = new Uint8Array(size)
	let offset = 0
	for (const part of parts) {
		body.set(part, offset)
		offset += part.byteLength
	}
	return new Response(body.buffer, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

async function readBoundedRequest(
	request: Request,
	maxBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array | undefined> {
	if (!request.body) return undefined
	const reader = request.body.getReader()
	const parts: Uint8Array[] = []
	let size = 0
	try {
		while (true) {
			const next = await waitForAbort(reader.read(), signal)
			if (next.done) break
			size += next.value.byteLength
			if (size > maxBytes) throw new Error('OAuth request body exceeds size limit')
			parts.push(next.value)
		}
	} catch (error) {
		cancelReader(reader, error)
		throw error
	} finally {
		reader.releaseLock()
	}
	const body = new Uint8Array(size)
	let offset = 0
	for (const part of parts) {
		body.set(part, offset)
		offset += part.byteLength
	}
	return body
}

function redirectStatus(status: number): boolean {
	return [301, 302, 303, 307, 308].includes(status)
}

function isConnectFailure(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	const code = (error as Error & { code?: string }).code
	return code !== undefined && CONNECT_FAILURES.has(code)
}

function redirectedHeaders(headers: Headers): Headers {
	const next = new Headers(headers)
	for (const name of [
		'authorization',
		'cookie',
		'proxy-authorization',
		'dpop',
		'host',
		'content-length',
		'transfer-encoding',
	]) {
		next.delete(name)
	}
	return next
}

async function pinnedFetch(
	input: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	config: {
		resolver: OAuthDnsResolver
		transport: OAuthTransport
		allowHttp: boolean
		allowLoopback: boolean
		timeoutMs: number
		maxBytes: number
	},
): Promise<Response> {
	const request = new Request(input, init)
	const timer = deadline(config.timeoutMs, request.signal)
	try {
		let currentUrl = parseRequestUrl(request.url, config.allowHttp)
		let method = request.method.toUpperCase()
		let headers = new Headers(request.headers)
		headers.delete('host')
		let body = await readBoundedRequest(request, MAX_REQUEST_BYTES, timer.signal)
		if (body === undefined) {
			headers.delete('content-length')
			headers.delete('transfer-encoding')
		} else {
			headers.delete('transfer-encoding')
			headers.set('content-length', String(body.byteLength))
		}

		for (let redirects = 0; ; redirects++) {
			const addresses = await waitForAbort(
				resolveAddresses(currentUrl, config.resolver, config.allowLoopback),
				timer.signal,
			)
			let response: Response | undefined
			let lastError: unknown
			for (const [index, address] of addresses.entries()) {
				try {
					const remaining = Math.max(1, config.timeoutMs)
					response = await waitForAbort(
						config.transport({
							url: currentUrl,
							address,
							method,
							headers,
							body,
							signal: timer.signal,
							timeoutMs: remaining,
						}),
						timer.signal,
					)
					break
				} catch (error) {
					lastError = error
					if (!isConnectFailure(error) || index === addresses.length - 1) throw error
				}
			}
			if (!response) throw lastError ?? new Error('OAuth request failed')
			response = await readBoundedResponse(response, config.maxBytes, timer.signal)
			if (!redirectStatus(response.status) || !response.headers.get('location')) return response
			if (request.redirect === 'manual') return response
			if (request.redirect === 'error') throw new Error('OAuth redirect blocked')
			if (redirects >= MAX_REDIRECTS) throw new Error('OAuth redirect limit exceeded')

			const location = response.headers.get('location') as string
			let nextUrl: URL
			try {
				nextUrl = new URL(location, currentUrl)
			} catch {
				throw new Error('OAuth redirect URL is invalid')
			}
			currentUrl = parseRequestUrl(nextUrl.toString(), config.allowHttp)
			headers = redirectedHeaders(headers)
			if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
				method = 'GET'
				body = undefined
			}
			if (body === undefined) {
				headers.delete('content-length')
				headers.delete('content-type')
			} else {
				headers.set('content-length', String(body.byteLength))
			}
		}
	} finally {
		timer.close()
	}
}

/**
 * Return a fetch-compatible function. Only the exact rewrite origin is sent
 * through ambient fetch, and only after the caller's LOCAL_DEV gate has passed.
 */
export const createOAuthFetch = (options: OAuthFetchOptions = {}): typeof fetch => {
	const hasRewrite = Boolean(options.rewriteFrom || options.rewriteTo)
	if (hasRewrite && (!options.rewriteFrom || !options.rewriteTo)) {
		throw new Error('OAUTH_FETCH_REWRITE_FROM and OAUTH_FETCH_REWRITE_TO must be set together')
	}
	if (hasRewrite && !localDevelopment()) throw new Error('OAuth fetch rewrites require LOCAL_DEV=true')

	const from = options.rewriteFrom ? new URL(options.rewriteFrom) : undefined
	const to = options.rewriteTo ? new URL(options.rewriteTo) : undefined
	if (
		from &&
		to &&
		(from.username ||
			from.password ||
			to.username ||
			to.password ||
			!['http:', 'https:'].includes(from.protocol) ||
			!['http:', 'https:'].includes(to.protocol))
	) {
		throw new Error('OAuth fetch rewrite origins are invalid')
	}

	const allowHttp = (options.allowHttp ?? environment('OAUTH_ALLOW_HTTP') === 'true') && localDevelopment()
	const config = {
		resolver: options.resolver ?? systemResolver,
		transport: options.transport ?? nodeTransport,
		allowHttp,
		allowLoopback: isIdentityLoopbackDevelopmentAllowed(),
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxBytes: MAX_RESPONSE_BYTES,
	}

	const oauthFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const original = input instanceof Request ? new URL(input.url) : new URL(String(input))
		if (from && to && original.origin === from.origin) {
			const target = new URL(`${original.pathname}${original.search}${original.hash}`, to)
			if (input instanceof Request) return globalThis.fetch(new Request(target, input), init)
			return globalThis.fetch(target, init)
		}
		return pinnedFetch(input, init, config)
	}) as unknown as typeof fetch
	oauthFetch.preconnect = globalThis.fetch.preconnect
	return oauthFetch
}
