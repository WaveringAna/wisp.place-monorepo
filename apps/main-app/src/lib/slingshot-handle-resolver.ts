import type { AtprotoDid } from '@atproto/did'
import type { HandleResolver, ResolvedHandle, ResolveHandleOptions } from '@atproto-labs/handle-resolver'
import {
	createPinnedIdentityFetcher,
	didWebToHttps,
	type IdentityDnsResolver,
	type PinnedIdentityTransport,
	readBoundedIdentityJson,
} from '@wispplace/atproto-utils'
import { logger } from './logger'

/** Maximum response accepted from the fixed Slingshot resolver. */
const MAX_RESOLVER_RESPONSE_BYTES = 64 * 1024
const RESOLVER_TIMEOUT_MS = 5_000
const PLC_DID_PATTERN = /^did:plc:[a-z2-7]{24}$/
const HANDLE_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

type SlingshotOptions = {
	resolver?: IdentityDnsResolver
	transport?: PinnedIdentityTransport
}

function safeLogHandle(value: string): string {
	return value.replace(/[^\x20-\x7e]/g, '?').slice(0, 253)
}

function isValidHandle(value: string): boolean {
	return value.length <= 253 && HANDLE_PATTERN.test(value)
}

function isSupportedDid(value: string): boolean {
	if (PLC_DID_PATTERN.test(value)) return true
	try {
		didWebToHttps(value)
		return true
	} catch {
		return false
	}
}

/**
 * Custom HandleResolver that uses Slingshot's identity resolver service
 * to work around bugs in atproto-oauth-node when handles have redirects
 * in their well-known configuration.
 *
 * Every resolver request goes through the built-in DNS-pinned identity
 * transport. The resolver response is bounded before JSON parsing and the
 * returned DID is restricted to the DID methods this service supports.
 */
export class SlingshotHandleResolver implements HandleResolver {
	private readonly endpoint: string
	private readonly fetcher: ReturnType<typeof createPinnedIdentityFetcher>

	constructor(
		endpoint = process.env.OAUTH_HANDLE_RESOLVER_URL ??
			'https://slingshot.microcosm.blue/xrpc/com.atproto.identity.resolveHandle',
		options: SlingshotOptions = {},
	) {
		this.endpoint = endpoint
		this.fetcher = createPinnedIdentityFetcher({
			resolver: options.resolver,
			transport: options.transport,
			timeoutMs: RESOLVER_TIMEOUT_MS,
			maxResponseBytes: MAX_RESOLVER_RESPONSE_BYTES,
			allowLoopback: true,
		})
	}

	async resolve(handle: string, options?: ResolveHandleOptions): Promise<ResolvedHandle> {
		const safeHandle = handle.trim().toLowerCase()
		if (!isValidHandle(safeHandle)) return null
		const logHandle = safeLogHandle(safeHandle)

		try {
			const url = new URL(this.endpoint)
			url.searchParams.set('handle', safeHandle)

			// The identity fetcher owns its own five-second deadline and forwards
			// the OAuth caller's signal through its pinned transport.
			const response = await this.fetcher(url.toString(), options?.signal ? { signal: options.signal } : undefined)
			const data = await readBoundedIdentityJson<unknown>(response, MAX_RESOLVER_RESPONSE_BYTES, options?.signal)
			if (!data || typeof data !== 'object' || typeof (data as { did?: unknown }).did !== 'string') {
				logger.warn('[SlingshotHandleResolver] Resolver returned no DID', { handle: logHandle })
				return null
			}
			const did = (data as { did: string }).did
			if (!isSupportedDid(did)) {
				logger.warn('[SlingshotHandleResolver] Resolver returned an unsupported DID', { handle: logHandle })
				return null
			}

			logger.debug('[SlingshotHandleResolver] Handle resolved', { handle: logHandle })
			return did as AtprotoDid
		} catch (error) {
			if (options?.signal?.aborted) throw error
			if (error instanceof Error && error.name === 'AbortError') throw error
			// Do not log errors from a remote server: they may contain URLs,
			// response bodies, or credentials supplied by that server.
			logger.warn('[SlingshotHandleResolver] Handle resolution failed', { handle: logHandle })
			return null
		}
	}
}
