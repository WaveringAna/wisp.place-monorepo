import { Buffer } from 'node:buffer'
import { isIP } from 'node:net'
import type {
	ResolvedAddress,
	SafeFetchResolver,
	SafeFetchTransport,
	SafeFetchTransportRequest,
} from '@wispplace/safe-fetch'
import {
	isLocalhostFetchAllowed,
	isLoopbackIpAddress,
	isPublicIpAddress,
	SafeFetchError,
	safeFetch,
} from '@wispplace/safe-fetch'

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

/** Keep the webhook seam source-compatible while sharing safe-fetch types. */
export type WebhookResolvedAddress = ResolvedAddress

/** Test seam. Production uses the OS resolver and validates every answer. */
export type WebhookResolver = SafeFetchResolver

/** Test seam for a pinned socket transport. */
export type WebhookTransportRequest = SafeFetchTransportRequest

/**
 * Test seam for a pinned socket transport. A production request always reaches
 * the validated `address`, not a later DNS lookup for `url.hostname`.
 */
export type WebhookTransport = SafeFetchTransport

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

/** The development escape hatch is intentionally both opt-in and loopback-only. */
export function isWebhookLoopbackDevelopmentAllowed(): boolean {
	return isLocalhostFetchAllowed()
}

function mayAllowLoopback(requested: boolean | undefined): boolean {
	return requested === true && isWebhookLoopbackDevelopmentAllowed()
}

function normalizeHostname(hostname: string): string {
	return hostname.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '').toLowerCase()
}

/** Returns true only for globally routable, non-special-purpose IP addresses. */
export function isPublicWebhookIpAddress(address: string): boolean {
	return isPublicIpAddress(address)
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
		isIPLiteral(hostname) &&
		!isPublicWebhookIpAddress(hostname) &&
		!(allowLoopback && isLoopbackIpAddress(hostname))
	) {
		throw new WebhookUrlError('blocked_destination', 'Webhook URL resolves to a private address')
	}

	return parsed
}

function isIPLiteral(hostname: string): boolean {
	return isIP(hostname) !== 0
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
	return typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength
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

function redirectHeadersToStrip(): readonly string[] {
	return ['x-webhook-signature', 'x-api-key']
}

function methodChangeHeadersToStrip(): readonly string[] {
	return ['content-type', 'content-length']
}

function webhookResponseAbortError(signal: AbortSignal): Error {
	const reason = signal.reason
	if (reason instanceof SafeFetchError && reason.kind === 'timeout') {
		return new WebhookUrlError('timeout', 'Webhook request timed out')
	}
	if (reason instanceof Error) return reason
	return new WebhookUrlError('timeout', 'Webhook request timed out')
}

function safeTransportError(error: unknown): WebhookUrlError {
	if (error instanceof WebhookUrlError) return error
	if (error instanceof SafeFetchError && error.cause instanceof WebhookUrlError) return error.cause
	if (error instanceof SafeFetchError) {
		switch (error.kind) {
			case 'invalid_url':
				return new WebhookUrlError('invalid_url', 'Webhook URL is invalid')
			case 'blocked_destination':
				return new WebhookUrlError('blocked_destination', 'Webhook URL resolves to a private address')
			case 'dns':
				return new WebhookUrlError('dns', 'Webhook DNS resolution failed')
			case 'timeout':
				return new WebhookUrlError('timeout', 'Webhook request timed out')
			case 'redirect':
				return new WebhookUrlError('redirect', 'Webhook redirect is invalid')
			case 'request_too_large':
				return new WebhookUrlError('request_too_large', 'Webhook request is too large')
			case 'response_too_large':
				return new WebhookUrlError('response_too_large', 'Webhook response is too large')
		}
	}
	if (error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('timeout'))) {
		return new WebhookUrlError('timeout', 'Webhook request timed out')
	}
	return new WebhookUrlError('network', 'Webhook request failed')
}

function wrapResolver(resolver: WebhookResolver | undefined): SafeFetchResolver | undefined {
	if (!resolver) return undefined
	return async (hostname) => {
		try {
			return await resolver(hostname)
		} catch (error) {
			const webhookError =
				error instanceof WebhookUrlError ? error : new WebhookUrlError('dns', 'Webhook DNS resolution failed')
			throw new SafeFetchError('dns', 'Webhook DNS resolution failed', webhookError)
		}
	}
}

function validateWebhookUrlForFetch(url: URL, allowLoopback: boolean): void {
	parseWebhookUrl(url.toString(), allowLoopback)
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
	try {
		await safeFetch(parsed.toString(), {
			method: 'HEAD',
			timeout: timeoutMs,
			maxSize: 0,
			resolver: wrapResolver(options?.resolver),
			transport: async () => new Response(null, { status: 204 }),
			allowLocalhost: allowLoopback,
			defaultUserAgent: null,
			urlValidator: (candidate) => validateWebhookUrlForFetch(candidate, allowLoopback),
		})
	} catch (error) {
		throw safeTransportError(error)
	}
}

/** Make a request through the shared DNS-pinned transport and webhook policy. */
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
	parseWebhookUrl(urlText, allowLoopback)
	try {
		return await safeFetch(urlText, {
			method: options?.method ?? 'POST',
			headers: initialHeaders(options?.headers, initialBody),
			body: initialBody as unknown as RequestInit['body'],
			timeout: timeoutMs,
			maxRedirects,
			maxRequestBodySize: maxRequestBytes,
			maxSize: maxResponseBytes,
			resolver: wrapResolver(options?.resolver),
			transport: options?.transport,
			allowLocalhost: allowLoopback,
			signal: options?.signal,
			defaultUserAgent: null,
			redirectHeadersToStrip: redirectHeadersToStrip(),
			methodChangeHeadersToStrip: methodChangeHeadersToStrip(),
			redirectError: (kind) =>
				new WebhookUrlError(
					'redirect',
					kind === 'limit' ? 'Webhook redirect limit exceeded' : 'Webhook redirect is invalid',
				),
			responseSizeError: () => new WebhookUrlError('response_too_large', 'Webhook response is too large'),
			responseAbortError: webhookResponseAbortError,
			urlValidator: (candidate) => validateWebhookUrlForFetch(candidate, allowLoopback),
		})
	} catch (error) {
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
