/**
 * Rewrite one exact public OAuth origin to an internal container origin.
 *
 * The reference PDS advertises `http://localhost:<port>` in dev mode so browser
 * redirects remain loopback-safe. In the compose harness, server-side OAuth requests
 * originate in the main-app container, where that loopback address is not the PDS.
 * This narrow rewrite preserves the advertised URLs while routing only those fetches
 * over the compose network.
 */
export const createOAuthFetch = (options: { rewriteFrom?: string; rewriteTo?: string }): typeof fetch => {
	const { rewriteFrom, rewriteTo } = options
	if (!rewriteFrom && !rewriteTo) return globalThis.fetch
	if (!rewriteFrom || !rewriteTo) {
		throw new Error('OAUTH_FETCH_REWRITE_FROM and OAUTH_FETCH_REWRITE_TO must be set together')
	}

	const from = new URL(rewriteFrom)
	const to = new URL(rewriteTo)

	const oauthFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const original = input instanceof Request ? new URL(input.url) : new URL(String(input))
		if (original.origin !== from.origin) return globalThis.fetch(input, init)

		const target = new URL(`${original.pathname}${original.search}${original.hash}`, to)
		if (input instanceof Request) {
			return globalThis.fetch(new Request(target, input), init)
		}
		return globalThis.fetch(target, init)
	}) as unknown as typeof fetch
	oauthFetch.preconnect = globalThis.fetch.preconnect
	return oauthFetch
}
