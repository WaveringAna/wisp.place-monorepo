import {
	privateSiteUrl as buildPrivateSiteUrl,
	privateGrantUrlFor,
	privateShareLinkUrl,
} from '@wispplace/private-sites'

const BASE_HOST = (process.env.BASE_HOST || process.env.BASE_DOMAIN || 'wisp.place').split(':')[0] || 'wisp.place'
export const privateHost = (): string => process.env.PRIVATE_HOST || `priv.${BASE_HOST}`

const scheme = (): 'http' | 'https' =>
	process.env.LOCAL_DEV === 'true' || process.env.NODE_ENV !== 'production' ? 'http' : 'https'
export const privateSiteUrl = (siteId: string): string => buildPrivateSiteUrl(siteId, privateHost(), scheme())
export const privateOwnerUrl = (siteId: string, handoff: string): string =>
	privateGrantUrlFor(privateSiteUrl(siteId), handoff)
export const privateShareUrl = (siteId: string, token: string): string =>
	privateShareLinkUrl(privateSiteUrl(siteId), token)
export const shortShareUrl = (token: string): string => {
	const base = (process.env.MAIN_APP_URL || process.env.DOMAIN || `https://${BASE_HOST}`).replace(/\/+$/, '')
	return `${base}/p/${encodeURIComponent(token)}`
}
