import { CompositeDidDocumentResolver, PlcDidDocumentResolver, WebDidDocumentResolver } from '@atcute/identity-resolver'
import { ServiceJwtVerifier } from '@atcute/xrpc-server/auth'
import { createPinnedIdentityFetcher, type PinnedIdentityFetcherOptions } from '@wispplace/atproto-utils'

export const createXrpcServiceJwtVerifier = (
	serviceDid: `did:${string}:${string}`,
	options: Pick<PinnedIdentityFetcherOptions, 'resolver' | 'transport'> = {},
) => {
	// Issuer resolution happens before signature verification. Never use raw fetch here.
	const get = createPinnedIdentityFetcher({
		resolver: options.resolver,
		transport: options.transport,
		timeoutMs: 5_000,
		maxResponseBytes: 20 * 1024,
		maxRedirects: 0,
		// The shared transport also requires both explicit development environment flags.
		allowLoopback: true,
	})
	const fetchDid = ((input, init) => {
		const url = input instanceof Request ? input.url : input.toString()
		return get(url, { signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) })
	}) as typeof fetch

	return new ServiceJwtVerifier({
		serviceDid,
		resolver: new CompositeDidDocumentResolver({
			methods: {
				// Devnet DIDs exist only in its local PLC directory.
				plc: new PlcDidDocumentResolver(
					Bun.env.WISP_PLC_DIRECTORY_URL ? { apiUrl: Bun.env.WISP_PLC_DIRECTORY_URL } : undefined,
				),
				web: new WebDidDocumentResolver({ fetch: fetchDid }),
			},
		}),
	})
}
