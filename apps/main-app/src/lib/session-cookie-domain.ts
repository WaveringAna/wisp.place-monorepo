/**
 * Scope of the account session cookie.
 *
 * The cookie must reach the private-site host (`priv.<base host>`) so the hosting service
 * can authorize a site's owner, which means it is scoped to the registrable domain rather
 * than to main-app's host alone.
 *
 * This widening is safe because:
 *   - the cookie is `httpOnly`, so user-uploaded scripts on sibling hosts cannot read it
 *   - the hosting service only accepts the cookie on the dedicated private host, which
 *     never serves user-controlled content, so a public site cannot use an ambient session
 *     to read private responses same-origin
 *
 * Returns `undefined` for hosts where a domain attribute is not meaningful (bare
 * `localhost`, IP literals), leaving the cookie host-only in local development.
 */

import { BASE_HOST } from '@wispplace/constants'

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

export const sessionCookieDomain = (baseHost: string = BASE_HOST): string | undefined => {
	const host = (process.env.COOKIE_DOMAIN ?? baseHost).split(':')[0]?.trim().toLowerCase()

	if (!host) return undefined
	if (host === 'localhost' || host.endsWith('.localhost')) return undefined
	if (IPV4.test(host)) return undefined
	if (!host.includes('.')) return undefined

	// A leading dot is legacy syntax; modern browsers treat `example.com` as covering
	// subdomains already.
	return host.replace(/^\./, '')
}
