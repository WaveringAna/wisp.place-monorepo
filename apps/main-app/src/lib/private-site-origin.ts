/**
 * Where private sites live, as seen from main-app.
 *
 * Kept separate from both the route modules and the service layer so that either can build
 * a private-origin URL without importing the other.
 */

import { privateSiteUrl as buildPrivateSiteUrl } from '@wispplace/private-sites'

const BASE_HOST = (process.env.BASE_HOST || process.env.BASE_DOMAIN || 'wisp.place').split(':')[0] || 'wisp.place'

/**
 * Base hostname under which each private site gets its own origin.
 *
 * Sites are served from `<siteId>.<privateHost>` rather than a shared path namespace, so
 * one tenant's JavaScript cannot read another tenant's content same-origin.
 */
export const privateHost = (): string => process.env.PRIVATE_HOST || `priv.${BASE_HOST}`

const scheme = (): 'http' | 'https' =>
	process.env.LOCAL_DEV === 'true' || process.env.NODE_ENV !== 'production' ? 'http' : 'https'

/** Per-site origin URL. Opening it without a credential yields a 404. */
export const privateSiteUrl = (siteId: string): string => buildPrivateSiteUrl(siteId, privateHost(), scheme())

/**
 * Human-friendly share link: `https://wisp.place/p/<token>`.
 *
 * The short form is what people paste into a chat. It redirects to the site's own origin
 * carrying the same credential, so it is a nicer presentation of one share, not a second
 * one to revoke.
 */
export const shortShareUrl = (token: string): string => {
	const base = (process.env.MAIN_APP_URL || process.env.DOMAIN || `https://${BASE_HOST}`).replace(/\/+$/, '')
	return `${base}/p/${encodeURIComponent(token)}`
}
