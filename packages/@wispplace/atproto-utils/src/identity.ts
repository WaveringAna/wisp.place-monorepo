/**
 * Remote AT Protocol identity helpers.
 *
 * Identity reads take an injected GET function. Server callers use the pinned
 * transport below; unsafeRawIdentityGet exists only for explicit CLI workflows.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { pinnedKeepAliveAgent } from './pinned-agent'

const HANDLE_RESOLVER = 'https://slingshot.microcosm.blue/xrpc/com.atproto.identity.resolveHandle'
const PLC_DIRECTORY = 'https://plc.directory'
export const MAX_IDENTITY_JSON_BYTES = 1024 * 1024
const MAX_URL_BYTES = 8192
const MAX_TIMEOUT_MS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3
const DEFAULT_IDENTITY_CACHE_TTL_MS = 5 * 60_000
const DEFAULT_IDENTITY_CACHE_ENTRIES = 64
const MAX_IDENTITY_CACHE_ENTRIES = 256
const DEFAULT_IDENTITY_CACHE_BYTES = 16 * 1024 * 1024
const MAX_IDENTITY_CACHE_BYTES = 64 * 1024 * 1024
const MAX_IDENTITY_CACHE_VERSIONS = 4096
const DEFAULT_IDENTITY_CACHE_INFLIGHT_TIMEOUT_MS = 10_000
const MAX_IDENTITY_CACHE_INFLIGHT_TIMEOUT_MS = 30_000
const MAX_IDENTITY_FAILURE_CACHE_MS = 10_000
const BLOCKED_HOSTS = new Set(['metadata.google.internal'])

type AddressFamily = 4 | 6
export interface IdentityFetchOptions {
	signal?: AbortSignal
	/** Charge buffered response bytes to a caller-owned revalidation budget. */
	byteBudget?: { consume(bytes: number): void }
}
export type IdentityGetFetcher = (url: string, options?: IdentityFetchOptions) => Promise<Response>
export interface IdentityResolvedAddress {
	address: string
	family: AddressFamily
}
export type IdentityDnsResolver = (hostname: string) => Promise<readonly IdentityResolvedAddress[]>
export interface PinnedIdentityRequest {
	url: URL
	address: IdentityResolvedAddress
	signal: AbortSignal
	timeoutMs: number
}
export type PinnedIdentityTransport = (request: PinnedIdentityRequest) => Promise<Response>
export interface PinnedIdentityFetcherOptions {
	resolver?: IdentityDnsResolver
	transport?: PinnedIdentityTransport
	timeoutMs?: number
	maxResponseBytes?: number
	maxRedirects?: number
	/** Only works with NODE_ENV=development and WISP_ALLOW_LOCALHOST_FETCH=1. */
	allowLoopback?: boolean
}
export interface IdentityPdsOptions {
	allowLoopback?: boolean
}

export interface IdentityCacheRequestOptions extends IdentityFetchOptions {
	/** Serve a bounded stale positive entry without attempting a refresh. */
	allowStale?: boolean
	/** Refresh first, then use a bounded stale positive entry only on failure. */
	staleIfError?: boolean
}

export interface IdentityCacheOptions {
	maxEntries?: number
	/** Total buffered response-body budget; defaults to 16 MiB and caps at 64 MiB. */
	maxCacheBytes?: number
	maxInFlight?: number
	/** Strict deadline for a shared source request, independent of individual callers. */
	inFlightTimeoutMs?: number
	ttlMs?: number
	staleTtlMs?: number
	failureTtlMs?: number
	maxResponseBytes?: number
	now?: () => number
}

export interface CachedIdentityGetFetcher extends IdentityGetFetcher {
	get(url: string, options?: IdentityCacheRequestOptions): Promise<Response>
	clear(): void
	invalidate(url: string): void
	readonly size: number
}

interface DidDocument {
	service: Array<{ id: string; serviceEndpoint: string }>
	alsoKnownAs: string[]
}

function env(name: string): string | undefined {
	return process.env[name] || (typeof Bun !== 'undefined' ? Bun.env[name] : undefined)
}
function hostname(host: string): string {
	return host.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}
function isDevLoopback(options?: { allowLoopback?: boolean }): boolean {
	return (
		options?.allowLoopback === true && env('NODE_ENV') === 'development' && env('WISP_ALLOW_LOCALHOST_FETCH') === '1'
	)
}
export function isIdentityLoopbackDevelopmentAllowed(): boolean {
	return isDevLoopback({ allowLoopback: true })
}
/** Explicitly unsafe, raw CLI transport. Never use this in a network service. */
export const unsafeRawIdentityGet: IdentityGetFetcher = (url, options) => fetch(url, { signal: options?.signal })

function ipv4(address: string): number[] | null {
	const parts = address.split('.')
	if (parts.length !== 4) return null
	const values = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN))
	return values.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ? null : values
}
function ipv4In(values: number[], base: readonly number[], bits: number): boolean {
	let remaining = bits
	for (let i = 0; i < 4 && remaining > 0; i++) {
		const width = Math.min(remaining, 8)
		const mask = (0xff << (8 - width)) & 0xff
		if (((values[i] ?? 0) & mask) !== ((base[i] ?? 0) & mask)) return false
		remaining -= width
	}
	return true
}
const PRIVATE_V4: ReadonlyArray<readonly [readonly number[], number]> = [
	[[0, 0, 0, 0], 8],
	[[10, 0, 0, 0], 8],
	[[100, 64, 0, 0], 10],
	[[127, 0, 0, 0], 8],
	[[169, 254, 0, 0], 16],
	[[172, 16, 0, 0], 12],
	[[192, 0, 0, 0], 24],
	[[192, 0, 2, 0], 24],
	[[192, 31, 196, 0], 24],
	[[192, 52, 193, 0], 24],
	[[192, 88, 99, 0], 24],
	[[192, 168, 0, 0], 16],
	[[192, 175, 48, 0], 24],
	[[198, 18, 0, 0], 15],
	[[198, 51, 100, 0], 24],
	[[203, 0, 113, 0], 24],
	[[224, 0, 0, 0], 4],
	[[240, 0, 0, 0], 4],
]
function expandIpv4Tail(source: string): string | null {
	if (!source.includes('.')) return source
	const cut = source.lastIndexOf(':')
	const tail = cut < 0 ? null : ipv4(source.slice(cut + 1))
	if (!tail) return null
	const first = ((tail[0] ?? 0) << 8) | (tail[1] ?? 0)
	const second = ((tail[2] ?? 0) << 8) | (tail[3] ?? 0)
	return `${source.slice(0, cut)}:${first.toString(16)}:${second.toString(16)}`
}

function parseIpv6Words(part: string): number[] | null {
	if (!part) return []
	const words = part.split(':')
	return words.every((word) => /^[0-9a-f]{1,4}$/.test(word)) ? words.map((word) => Number.parseInt(word, 16)) : null
}

function expandIpv6Words(source: string): number[] | null {
	const halves = source.split('::')
	if (halves.length > 2) return null
	const left = parseIpv6Words(halves[0] ?? '')
	const right = parseIpv6Words(halves[1] ?? '')
	if (!left || !right) return null
	const missing = 8 - left.length - right.length
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
	return halves.length === 1 ? left : [...left, ...Array<number>(missing).fill(0), ...right]
}

function ipv6(address: string): bigint | null {
	if (address.includes('%')) return null
	const expanded = expandIpv4Tail(address.toLowerCase())
	const words = expanded === null ? null : expandIpv6Words(expanded)
	return words?.reduce((result, word) => (result << 16n) | BigInt(word), 0n) ?? null
}
function hasPrefix(address: bigint, prefix: bigint, bits: number): boolean {
	const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits)
	return (address & mask) === (prefix & mask)
}
const SPECIAL_V6: ReadonlyArray<readonly [bigint, number]> = [
	// 2001:0000::/23 deliberately covers all IETF special subranges through
	// 2001:01ff::, including 2001:2/48, 2001:3/32, 2001:4:112/48,
	// ORCHID (2001:10::/28), and ORCHIDv2 (2001:20::/28).
	[0x2001n << 112n, 23],
	[(0x2001n << 112n) | (0x0db8n << 96n), 32],
	// NAT64 may translate an apparently global IPv6 destination to a private IPv4 address.
	[(0x0064n << 112n) | (0xff9bn << 96n), 96],
	[(0x0064n << 112n) | (0xff9bn << 96n) | (0x0001n << 80n), 48],
	[0x2002n << 112n, 16],
	[(0x2620n << 112n) | (0x004fn << 96n) | (0x8000n << 80n), 48],
	[0x3fffn << 112n, 20],
]
/** True only for global unicast addresses, excluding special-purpose ranges. */
export function isPublicIdentityAddress(address: string): boolean {
	const value = hostname(address)
	if (isIP(value) === 4) {
		const parsed = ipv4(value)
		return parsed !== null && !PRIVATE_V4.some(([base, bits]) => ipv4In(parsed, base, bits))
	}
	if (isIP(value) !== 6) return false
	const parsed = ipv6(value)
	return (
		parsed !== null &&
		hasPrefix(parsed, 0x2000n << 112n, 3) &&
		!SPECIAL_V6.some(([base, bits]) => hasPrefix(parsed, base, bits))
	)
}
function isLoopback(address: string): boolean {
	const value = hostname(address)
	const v4 = ipv4(value)
	return v4?.[0] === 127 || ipv6(value) === 1n
}
function isLoopbackName(value: string): boolean {
	const host = hostname(value)
	return host === 'localhost' || host.endsWith('.localhost') || isLoopback(host)
}
function validName(value: string): boolean {
	const host = hostname(value)
	if (isIP(host) !== 0) return true
	return (
		host.length > 0 &&
		host.length <= 253 &&
		host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))
	)
}
function validHost(value: string, allowLoopback: boolean): boolean {
	const host = hostname(value)
	if (!host || BLOCKED_HOSTS.has(host)) return false
	if (isLoopbackName(host)) return allowLoopback
	return isIP(host) === 0 ? validName(host) : isPublicIdentityAddress(host)
}
function checkedUrl(raw: string, allowLoopback: boolean): URL {
	if (raw.length > MAX_URL_BYTES) throw new Error('Identity URL is invalid')
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new Error('Identity URL is invalid')
	}
	if (!url.hostname || url.username || url.password || url.hash || !validHost(url.hostname, allowLoopback))
		throw new Error('Identity URL is invalid')
	if (url.protocol === 'https:') return url
	if (url.protocol === 'http:' && allowLoopback && isLoopbackName(url.hostname)) return url
	throw new Error('Identity URL must use HTTPS')
}
async function resolve(
	host: string,
	resolver: IdentityDnsResolver,
	allowLoopback: boolean,
): Promise<IdentityResolvedAddress[]> {
	const name = hostname(host)
	const family = isIP(name)
	const answers =
		family === 4 || family === 6 ? [{ address: name, family: family as AddressFamily }] : await resolver(name)
	if (!answers.length) throw new Error('Identity DNS returned no addresses')
	const local = allowLoopback && isLoopbackName(name)
	const checked = answers.map((answer) => {
		if (!answer || typeof answer.address !== 'string' || (answer.family !== 4 && answer.family !== 6)) {
			throw new Error('Identity DNS answer is invalid')
		}
		const address = hostname(answer.address)
		if (isIP(address) !== answer.family || !(isPublicIdentityAddress(address) || (local && isLoopback(address)))) {
			throw new Error('Identity DNS address is not public')
		}
		return { address, family: answer.family }
	})
	if (checked.some((answer) => isLoopback(answer.address)) && checked.some((answer) => !isLoopback(answer.address))) {
		throw new Error('Identity DNS answers are mixed')
	}
	return checked
}
const systemResolver: IdentityDnsResolver = async (host) => {
	const answers = await dnsLookup(host, { all: true, verbatim: true })
	return answers.flatMap((answer) =>
		answer.family === 4 || answer.family === 6 ? [{ address: answer.address, family: answer.family }] : [],
	)
}
function race<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error('Identity request timed out'))
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error('Identity request timed out'))
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
function headersFromNode(values: Record<string, string | string[] | number | undefined>): Headers {
	const headers = new Headers()
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry)
		} else {
			headers.set(name, String(value))
		}
	}
	return headers
}
const pinnedTransport: PinnedIdentityTransport = async ({ url, address, signal, timeoutMs }) => {
	const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
	return new Promise<Response>((resolve, reject) => {
		let incoming: { destroy: (error?: Error) => void } | undefined
		const request = requestFn(
			{
				protocol: url.protocol,
				hostname: hostname(url.hostname),
				port: url.port ? Number(url.port) : undefined,
				path: `${url.pathname}${url.search}`,
				method: 'GET',
				headers: { Accept: 'application/json' },
				// Pooled per validated address, so a reused socket is always already
				// connected to an answer that passed validation. See pinned-agent.ts.
				agent: pinnedKeepAliveAgent(url, address),
				servername:
					url.protocol === 'https:' && isIP(hostname(url.hostname)) === 0 ? hostname(url.hostname) : undefined,
				// This lookup is the connection path, not merely a preflight check.
				lookup: (_name, options, callback) =>
					options.all
						? callback(null, [{ address: address.address, family: address.family }])
						: callback(null, address.address, address.family),
			},
			(response) => {
				incoming = response
				const clearAbort = () => signal.removeEventListener('abort', abort)
				response.once('end', clearAbort)
				response.once('close', clearAbort)
				response.once('error', clearAbort)
				const hasBody = ![204, 205, 304].includes(response.statusCode ?? 0)
				if (!hasBody) response.resume()
				resolve(
					new Response(hasBody ? (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>) : null, {
						status: response.statusCode ?? 502,
						statusText: response.statusMessage,
						headers: headersFromNode(response.headers),
					}),
				)
			},
		)
		const abort = () => {
			const error = new Error('Identity request timed out')
			incoming?.destroy(error)
			request.destroy(error)
		}
		if (signal.aborted) abort()
		else signal.addEventListener('abort', abort, { once: true })
		request.once('error', () => {
			signal.removeEventListener('abort', abort)
			reject(new Error('Identity request failed'))
		})
		request.setTimeout(timeoutMs, abort)
		request.end()
	})
}
async function cancel(response: Response): Promise<void> {
	try {
		await response.body?.cancel()
	} catch {
		/* peer closed first */
	}
}
async function bytes(
	response: Response,
	limit: number,
	signal?: AbortSignal,
	byteBudget?: { consume(bytes: number): void },
): Promise<Uint8Array> {
	const length = response.headers.get('content-length')
	if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
		await cancel(response)
		throw new Error('Identity response exceeds size limit')
	}
	if (!response.body) return new Uint8Array()
	const reader = response.body.getReader(),
		parts: Uint8Array[] = []
	let size = 0
	const abort = () => void reader.cancel()
	signal?.addEventListener('abort', abort, { once: true })
	try {
		while (true) {
			const next = signal ? await race(reader.read(), signal) : await reader.read()
			if (next.done) break
			byteBudget?.consume(next.value.byteLength)
			size += next.value.byteLength
			if (size > limit) {
				await reader.cancel()
				throw new Error('Identity response exceeds size limit')
			}
			parts.push(next.value)
		}
	} catch (error) {
		try {
			await reader.cancel(error)
		} catch {
			// Preserve the original read or budget failure.
		}
		throw error
	} finally {
		signal?.removeEventListener('abort', abort)
		reader.releaseLock()
	}
	const result = new Uint8Array(size)
	let offset = 0
	for (const part of parts) {
		result.set(part, offset)
		offset += part.byteLength
	}
	return result
}
function limit(value: number | undefined): number {
	const result = value ?? MAX_IDENTITY_JSON_BYTES
	if (!Number.isSafeInteger(result) || result < 0) throw new RangeError('Identity response limit is invalid')
	return Math.min(result, MAX_IDENTITY_JSON_BYTES)
}
/** Parse a successful JSON response under a hard byte cap. */
export async function readBoundedIdentityJson<T = unknown>(
	response: Response,
	maxBytes = MAX_IDENTITY_JSON_BYTES,
	signal?: AbortSignal,
	byteBudget?: { consume(bytes: number): void },
): Promise<T> {
	if (!response.ok) {
		await cancel(response)
		throw new Error('Identity request failed')
	}
	try {
		return JSON.parse(new TextDecoder().decode(await bytes(response, limit(maxBytes), signal, byteBudget))) as T
	} catch (error) {
		if (error instanceof Error && error.message === 'Identity response exceeds size limit') throw error
		const code = (error as { code?: unknown })?.code
		if (typeof code === 'string' && code.length > 0) throw error
		throw new Error('Identity response is not valid JSON')
	}
}
function redirect(status: number): boolean {
	return [301, 302, 303, 307, 308].includes(status)
}
function timeout(value: number | undefined): number {
	const result = value ?? DEFAULT_TIMEOUT_MS
	if (!Number.isFinite(result) || result <= 0) throw new RangeError('Identity timeout is invalid')
	return Math.min(Math.floor(result), MAX_TIMEOUT_MS)
}
function redirectLimit(value: number | undefined): number {
	const result = value ?? MAX_REDIRECTS
	if (!Number.isSafeInteger(result) || result < 0) throw new RangeError('Identity redirect limit is invalid')
	return Math.min(result, MAX_REDIRECTS)
}
interface PinnedIdentityConfig {
	resolver: IdentityDnsResolver
	transport: PinnedIdentityTransport
	timeoutMs: number
	maxBytes: number
	maxRedirects: number
	allowLoopback: boolean
}

async function openPinnedIdentityConnection(
	url: URL,
	config: PinnedIdentityConfig,
	signal: AbortSignal,
): Promise<Response> {
	const addresses = await race(resolve(url.hostname, config.resolver, config.allowLoopback), signal)
	try {
		return await race(
			config.transport({ url, address: addresses[0] as IdentityResolvedAddress, signal, timeoutMs: config.timeoutMs }),
			signal,
		)
	} catch {
		throw new Error('Identity request failed')
	}
}

async function bufferIdentityResponse(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
	byteBudget?: { consume(bytes: number): void },
): Promise<Response> {
	const body = await bytes(response, maxBytes, signal, byteBudget)
	const noBodyStatus = response.status === 204 || response.status === 205 || response.status === 304
	return new Response(noBodyStatus ? null : new Uint8Array(body).buffer, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}

async function nextPinnedIdentityUrl(response: Response, current: URL, maxRedirectsReached: boolean): Promise<URL> {
	if (maxRedirectsReached) {
		await cancel(response)
		throw new Error('Identity redirect limit exceeded')
	}
	try {
		return new URL(response.headers.get('location') as string, current)
	} catch {
		throw new Error('Identity redirect is invalid')
	} finally {
		await cancel(response)
	}
}

async function followPinnedIdentityRedirects(
	raw: string,
	config: PinnedIdentityConfig,
	signal: AbortSignal,
	byteBudget?: { consume(bytes: number): void },
): Promise<Response> {
	let url = checkedUrl(raw, config.allowLoopback)
	for (let count = 0; ; count++) {
		const response = await openPinnedIdentityConnection(url, config, signal)
		if (!redirect(response.status) || !response.headers.get('location')) {
			return bufferIdentityResponse(response, config.maxBytes, signal, byteBudget)
		}
		const next = await nextPinnedIdentityUrl(response, url, count >= config.maxRedirects)
		url = checkedUrl(next.toString(), config.allowLoopback)
	}
}

async function pinnedIdentityGet(
	raw: string,
	config: PinnedIdentityConfig,
	requestOptions: IdentityFetchOptions | undefined,
): Promise<Response> {
	const controller = new AbortController()
	const abort = () => controller.abort()
	const timer = setTimeout(abort, config.timeoutMs)
	if (requestOptions?.signal?.aborted) abort()
	else requestOptions?.signal?.addEventListener('abort', abort, { once: true })
	try {
		return await followPinnedIdentityRedirects(raw, config, controller.signal, requestOptions?.byteBudget)
	} finally {
		clearTimeout(timer)
		requestOptions?.signal?.removeEventListener('abort', abort)
	}
}

/** A bounded GET which validates all DNS answers and pins the chosen socket address. */
export function createPinnedIdentityFetcher(options: PinnedIdentityFetcherOptions = {}): IdentityGetFetcher {
	const config: PinnedIdentityConfig = {
		resolver: options.resolver ?? systemResolver,
		transport: options.transport ?? pinnedTransport,
		timeoutMs: timeout(options.timeoutMs),
		maxBytes: limit(options.maxResponseBytes),
		maxRedirects: redirectLimit(options.maxRedirects),
		allowLoopback: isDevLoopback(options),
	}
	return (raw, requestOptions) => pinnedIdentityGet(raw, config, requestOptions)
}

const MAX_IDENTITY_CACHE_TTL_MS = 60 * 60_000

interface CachedIdentityResponse {
	body: Uint8Array
	headers: Array<[string, string]>
	status: number
	statusText: string
	ok: boolean
	expiresAt: number
	staleUntil: number
}

interface IdentityCacheSlot {
	positive?: CachedIdentityResponse
	failure?: CachedIdentityResponse
}

interface InFlightIdentityResponse {
	epoch: number
	version: number
	controller: AbortController
	waiters: number
	settled: boolean
	promise: Promise<CachedIdentityResponse>
}

function cacheDuration(value: number | undefined, fallback: number, maximum: number, label: string): number {
	const duration = value ?? fallback
	if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`${label} is invalid`)
	return Math.min(Math.floor(duration), maximum)
}

function cacheCount(value: number | undefined, fallback: number, label: string): number {
	const count = value ?? fallback
	if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${label} is invalid`)
	return Math.min(count, MAX_IDENTITY_CACHE_ENTRIES)
}

function cacheByteLimit(value: number | undefined): number {
	const bytes = value ?? DEFAULT_IDENTITY_CACHE_BYTES
	if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError('Identity cache byte limit is invalid')
	return Math.min(bytes, MAX_IDENTITY_CACHE_BYTES)
}

function slotBytes(slot: IdentityCacheSlot): number {
	return (slot.positive?.body.byteLength ?? 0) + (slot.failure?.body.byteLength ?? 0)
}

function canonicalCacheKey(raw: string): string | null {
	try {
		const url = new URL(raw)
		url.hash = ''
		return url.toString()
	} catch {
		return null
	}
}

function responseFromCache(entry: CachedIdentityResponse): Response {
	const noBodyStatus = entry.status === 204 || entry.status === 205 || entry.status === 304
	return new Response(noBodyStatus ? null : new Uint8Array(entry.body).buffer, {
		status: entry.status,
		statusText: entry.statusText,
		headers: new Headers(entry.headers),
	})
}

async function cacheIdentityResponse(
	response: Response,
	maxBytes: number,
	now: number,
	signal?: AbortSignal,
	byteBudget?: { consume(bytes: number): void },
): Promise<CachedIdentityResponse> {
	const body = await bytes(response, maxBytes, signal, byteBudget)
	return {
		body: new Uint8Array(body),
		headers: [...response.headers.entries()],
		status: response.status,
		statusText: response.statusText,
		ok: response.ok,
		expiresAt: now,
		staleUntil: now,
	}
}

function identityAbortError(signal: AbortSignal): Error {
	// Caller-provided abort reasons are untrusted. Preserve only our own stable
	// cache deadline error; otherwise avoid exposing arbitrary reason text.
	if (signal.reason instanceof Error && signal.reason.message === 'Identity cache request timed out')
		return signal.reason
	return new Error('Identity request aborted')
}

function awaitIdentityResponse<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise
	if (signal.aborted) return Promise.reject(identityAbortError(signal))
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(identityAbortError(signal))
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

function awaitSharedIdentityResponse(
	entry: InFlightIdentityResponse,
	signal?: AbortSignal,
): Promise<CachedIdentityResponse> {
	entry.waiters++
	return awaitIdentityResponse(entry.promise, signal).finally(() => {
		entry.waiters--
		// A cancelled caller detaches from a shared request. Once all callers
		// have detached, release the source rather than waiting for its deadline.
		if (entry.waiters === 0 && !entry.settled) entry.controller.abort(new Error('Identity request abandoned'))
	})
}

/**
 * Wrap a pinned identity GET with bounded LRU response caching and in-flight
 * request de-duplication. Its callable form is always fresh-only; stale data
 * requires an explicit `.get()` request option.
 */
export function createCachedIdentityFetcher(
	source: IdentityGetFetcher,
	options: IdentityCacheOptions = {},
): CachedIdentityGetFetcher {
	const maxEntries = cacheCount(options.maxEntries, DEFAULT_IDENTITY_CACHE_ENTRIES, 'Identity cache entries')
	const configuredMaxInFlight = options.maxInFlight ?? Math.max(1, maxEntries || 64)
	if (!Number.isSafeInteger(configuredMaxInFlight) || configuredMaxInFlight < 1) {
		throw new RangeError('Identity cache in-flight limit is invalid')
	}
	const maxInFlight = Math.min(configuredMaxInFlight, MAX_IDENTITY_CACHE_ENTRIES)
	const maxResponseBytes = limit(options.maxResponseBytes)
	const maxCacheBytes = cacheByteLimit(options.maxCacheBytes)
	const inFlightTimeoutMs = cacheDuration(
		options.inFlightTimeoutMs,
		DEFAULT_IDENTITY_CACHE_INFLIGHT_TIMEOUT_MS,
		MAX_IDENTITY_CACHE_INFLIGHT_TIMEOUT_MS,
		'Identity cache in-flight timeout',
	)
	const ttlMs = cacheDuration(
		options.ttlMs,
		DEFAULT_IDENTITY_CACHE_TTL_MS,
		MAX_IDENTITY_CACHE_TTL_MS,
		'Identity cache TTL',
	)
	const staleTtlMs = cacheDuration(options.staleTtlMs, ttlMs, MAX_IDENTITY_CACHE_TTL_MS, 'Identity stale TTL')
	const failureTtlMs = cacheDuration(
		options.failureTtlMs,
		0,
		MAX_IDENTITY_FAILURE_CACHE_MS,
		'Identity failure cache TTL',
	)
	const now = options.now ?? Date.now
	const entries = new Map<string, IdentityCacheSlot>()
	const inflight = new Map<string, InFlightIdentityResponse>()
	const versions = new Map<string, number>()
	let epoch = 0

	let cachedBytes = 0
	const token = (key: string) => ({ epoch, version: versions.get(key) ?? 0 })
	const fresh = (entry: CachedIdentityResponse | undefined, at: number) => entry !== undefined && entry.expiresAt > at
	const stale = (entry: CachedIdentityResponse | undefined, at: number) => entry !== undefined && entry.staleUntil > at
	const detach = (key: string) => {
		const slot = entries.get(key)
		if (!slot) return undefined
		entries.delete(key)
		cachedBytes -= slotBytes(slot)
		return slot
	}
	const put = (key: string, slot: IdentityCacheSlot) => {
		const bytes = slotBytes(slot)
		if (maxEntries === 0 || bytes > maxCacheBytes || (!slot.positive && !slot.failure)) return
		entries.set(key, slot)
		cachedBytes += bytes
		while (entries.size > maxEntries || cachedBytes > maxCacheBytes) {
			const oldest = entries.keys().next().value as string
			detach(oldest)
		}
	}
	const read = (key: string, at: number) => {
		const slot = detach(key)
		if (!slot) return undefined
		if (slot.positive && slot.positive.staleUntil <= at) delete slot.positive
		if (slot.failure && slot.failure.expiresAt <= at) delete slot.failure
		if (!slot.positive && !slot.failure) return undefined
		put(key, slot)
		return slot
	}
	const save = (
		key: string,
		response: CachedIdentityResponse,
		at: number,
		tokenAtStart: { epoch: number; version: number },
	) => {
		if (maxEntries === 0 || epoch !== tokenAtStart.epoch || (versions.get(key) ?? 0) !== tokenAtStart.version) return
		const slot = detach(key) ?? {}
		if (response.ok && ttlMs > 0) {
			response.expiresAt = at + ttlMs
			response.staleUntil = response.expiresAt + staleTtlMs
			slot.positive = response
		} else if (!response.ok && failureTtlMs > 0) {
			response.expiresAt = at + failureTtlMs
			response.staleUntil = response.expiresAt
			slot.failure = response
		}
		put(key, slot)
	}

	const load = (
		key: string,
		url: string,
		tokenAtStart: { epoch: number; version: number },
		byteBudget?: { consume(bytes: number): void },
	) => {
		const current = inflight.get(key)
		if (current && current.epoch === tokenAtStart.epoch && current.version === tokenAtStart.version) return current
		if (inflight.size >= maxInFlight) throw new Error('Identity cache is busy')
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(new Error('Identity cache request timed out')), inFlightTimeoutMs)
		const promise = (async () => {
			const response = await awaitIdentityResponse(
				source(url, { signal: controller.signal, byteBudget }),
				controller.signal,
			)
			const cachedResponse = await cacheIdentityResponse(
				response,
				maxResponseBytes,
				now(),
				controller.signal,
				byteBudget,
			)
			save(key, cachedResponse, now(), tokenAtStart)
			return cachedResponse
		})()
		const entry: InFlightIdentityResponse = { ...tokenAtStart, controller, waiters: 0, settled: false, promise }
		inflight.set(key, entry)
		const cleanup = () => {
			entry.settled = true
			clearTimeout(timer)
			if (inflight.get(key)?.promise === promise) inflight.delete(key)
		}
		// Always observe the shared promise. A caller may abandon it through its
		// own AbortSignal, but that must never create an unhandled rejection.
		void promise.then(cleanup, cleanup)
		return entry
	}

	const get = async (url: string, request: IdentityCacheRequestOptions = {}): Promise<Response> => {
		if (request.signal?.aborted) throw identityAbortError(request.signal)
		const key = canonicalCacheKey(url)
		if (!key) return source(url, { signal: request.signal, byteBudget: request.byteBudget })
		const at = now()
		const slot = read(key, at)
		const previous = slot?.positive
		if (request.allowStale && previous && stale(previous, at)) return responseFromCache(previous)
		if (previous && fresh(previous, at)) return responseFromCache(previous)
		const failure = slot?.failure
		if (failure && fresh(failure, at)) {
			if (request.staleIfError && previous && stale(previous, at)) return responseFromCache(previous)
			return responseFromCache(failure)
		}
		try {
			const response = await awaitSharedIdentityResponse(load(key, url, token(key), request.byteBudget), request.signal)
			if (!response.ok && request.staleIfError && previous && stale(previous, now())) return responseFromCache(previous)
			return responseFromCache(response)
		} catch (error) {
			if (request.signal?.aborted) throw error
			if (request.staleIfError && previous && stale(previous, now())) return responseFromCache(previous)
			throw error
		}
	}
	const cached = ((url: string, requestOptions?: IdentityFetchOptions) =>
		get(url, { signal: requestOptions?.signal, byteBudget: requestOptions?.byteBudget })) as CachedIdentityGetFetcher
	cached.get = get
	cached.clear = () => {
		epoch++
		entries.clear()
		cachedBytes = 0
		inflight.clear()
	}
	cached.invalidate = (url: string) => {
		const key = canonicalCacheKey(url)
		if (!key) return
		if (!versions.has(key) && versions.size >= MAX_IDENTITY_CACHE_VERSIONS) {
			// Reset every token before evicting version state, so an old in-flight
			// response can never repopulate a cleared cache entry.
			epoch++
			entries.clear()
			cachedBytes = 0
			for (const entry of inflight.values()) entry.controller.abort(new Error('Identity cache cleared'))
			inflight.clear()
			versions.clear()
		}
		versions.set(key, (versions.get(key) ?? 0) + 1)
		detach(key)
		inflight.delete(key)
	}
	Object.defineProperty(cached, 'size', { get: () => entries.size })
	return cached
}

function didWebPart(value: string): string {
	if (!value || value.length > 1024) throw new Error('Invalid did:web format')
	try {
		return decodeURIComponent(value)
	} catch {
		throw new Error('Invalid did:web format')
	}
}
/** Convert a strictly-valid did:web into its HTTPS DID document URL. */
export function didWebToHttps(did: string): string {
	if (!did.startsWith('did:web:') || did.length > 2048) throw new Error('Invalid did:web format')
	const parts = did.slice(8).split(':'),
		host = didWebPart(parts.shift() ?? '')
	if (/[\\/?#@]/.test(host) || host.includes('\0')) throw new Error('Invalid did:web format')
	let origin: URL
	try {
		origin = new URL(`https://${host}`)
	} catch {
		throw new Error('Invalid did:web format')
	}
	if (
		origin.username ||
		origin.password ||
		origin.pathname !== '/' ||
		origin.search ||
		origin.hash ||
		!validName(origin.hostname) ||
		isIP(hostname(origin.hostname)) !== 0 ||
		isLoopbackName(origin.hostname)
	)
		throw new Error('Invalid did:web format')
	if (!parts.length) return new URL('/.well-known/did.json', origin).toString()
	const path = parts.map((part) => {
		const decoded = didWebPart(part)
		if (decoded === '.' || decoded === '..' || /[\\/?#]/.test(decoded) || decoded.includes('\0'))
			throw new Error('Invalid did:web format')
		return encodeURIComponent(decoded)
	})
	return new URL(`/${path.join('/')}/did.json`, origin).toString()
}
function plcDid(did: string): boolean {
	return /^did:plc:[a-z2-7]{24}$/.test(did)
}
function supportedDid(did: string): boolean {
	if (plcDid(did)) return true
	try {
		didWebToHttps(did)
		return true
	} catch {
		return false
	}
}
function safeHandle(value: string): boolean {
	return value.length <= 253 && isIP(hostname(value)) === 0 && !isLoopbackName(value) && validName(value)
}
function document(value: unknown): DidDocument | null {
	if (!value || typeof value !== 'object') return null
	const raw = value as { service?: unknown; alsoKnownAs?: unknown }
	const service = Array.isArray(raw.service)
		? raw.service.flatMap((entry) => {
				const item = entry as { id?: unknown; serviceEndpoint?: unknown } | null
				return item && typeof item.id === 'string' && typeof item.serviceEndpoint === 'string'
					? [{ id: item.id, serviceEndpoint: item.serviceEndpoint }]
					: []
			})
		: []
	return {
		service,
		alsoKnownAs: Array.isArray(raw.alsoKnownAs)
			? raw.alsoKnownAs.filter((item): item is string => typeof item === 'string')
			: [],
	}
}
function handleUrl(handle: string): string {
	const url = new URL(env('WISP_HANDLE_RESOLVER_URL') || HANDLE_RESOLVER)
	url.searchParams.set('handle', handle)
	return url.toString()
}
function plcUrl(did: string): string {
	const url = new URL(env('WISP_PLC_DIRECTORY_URL') || PLC_DIRECTORY)
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/${encodeURIComponent(did)}`
	url.search = ''
	url.hash = ''
	return url.toString()
}
async function getDocument(
	url: string,
	fetcher: IdentityGetFetcher,
	requestOptions?: IdentityFetchOptions,
): Promise<DidDocument | null> {
	const response = await fetcher(url, requestOptions)
	if (!response.ok) {
		await cancel(response)
		return null
	}
	return document(
		await readBoundedIdentityJson(
			response,
			MAX_IDENTITY_JSON_BYTES,
			requestOptions?.signal,
			requestOptions?.byteBudget,
		),
	)
}
/** Fetch a supported DID document. The fetcher is mandatory. */
export async function getDidDocument(
	did: string,
	fetcher: IdentityGetFetcher,
	requestOptions?: IdentityFetchOptions,
): Promise<DidDocument | null> {
	try {
		return plcDid(did)
			? await getDocument(plcUrl(did), fetcher, requestOptions)
			: did.startsWith('did:web:')
				? await getDocument(didWebToHttps(did), fetcher, requestOptions)
				: null
	} catch {
		return null
	}
}
/** Resolve a handle or supported DID. The fetcher is mandatory. */
export async function resolveDid(
	identifier: string,
	fetcher: IdentityGetFetcher,
	requestOptions?: IdentityFetchOptions,
): Promise<string | null> {
	try {
		if (identifier.startsWith('did:')) return supportedDid(identifier) ? identifier : null
		const handle = identifier.trim().toLowerCase()
		if (!safeHandle(handle)) return null
		const response = await fetcher(handleUrl(handle), requestOptions)
		if (!response.ok) {
			await cancel(response)
			return null
		}
		const data = await readBoundedIdentityJson<{ did?: unknown }>(
			response,
			MAX_IDENTITY_JSON_BYTES,
			requestOptions?.signal,
			requestOptions?.byteBudget,
		)
		if (typeof data.did !== 'string' || !supportedDid(data.did)) return null
		const didDocument = await getDidDocument(data.did, fetcher, requestOptions)
		return didDocument?.alsoKnownAs.some((aka) => aka.toLowerCase() === `at://${handle}`) ? data.did : null
	} catch {
		return null
	}
}
/** Validate a PDS endpoint before it is ever used to make a PDS request. */
export function validatePdsEndpoint(endpoint: string, options?: IdentityPdsOptions): string | null {
	let url: URL
	try {
		url = checkedUrl(endpoint, isDevLoopback(options))
	} catch {
		return null
	}
	if (url.search || url.hash) return null
	return url.toString().replace(/\/$/, '')
}
/** Get a validated HTTPS PDS endpoint from a DID document. */
export async function getPdsForDid(
	did: string,
	fetcher: IdentityGetFetcher,
	options?: IdentityPdsOptions,
	requestOptions?: IdentityFetchOptions,
): Promise<string | null> {
	try {
		const endpoint = (await getDidDocument(did, fetcher, requestOptions))?.service.find(
			(service) => service.id === '#atproto_pds',
		)?.serviceEndpoint
		return endpoint ? validatePdsEndpoint(endpoint, options) : null
	} catch {
		return null
	}
}
/** Get the safe handle value from a DID document. */
export async function getHandleForDid(
	did: string,
	fetcher: IdentityGetFetcher,
	requestOptions?: IdentityFetchOptions,
): Promise<string | null> {
	try {
		const aka = (await getDidDocument(did, fetcher, requestOptions))?.alsoKnownAs.find((value) =>
			value.toLowerCase().startsWith('at://'),
		)
		const value = aka?.slice(5)
		return value && safeHandle(value) ? value : null
	} catch {
		return null
	}
}
export async function resolvePdsFromHandle(
	handle: string,
	fetcher: IdentityGetFetcher,
	options?: IdentityPdsOptions,
	requestOptions?: IdentityFetchOptions,
): Promise<string> {
	const did = await resolveDid(handle, fetcher, requestOptions)
	if (!did) throw new Error('Failed to resolve handle')
	const endpoint = await getPdsForDid(did, fetcher, options, requestOptions)
	if (!endpoint) throw new Error('Could not find a valid PDS endpoint')
	return endpoint
}
