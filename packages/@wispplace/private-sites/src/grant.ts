import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { PRIVATE_SHARE_QUERY_PARAM } from '@wispplace/constants'
export const PRIVATE_SESSION_COOKIE = 'wsps'
export const PRIVATE_SESSION_COOKIE_SECURE = '__Host-wsps'
export const sessionCookieName = (secure: boolean): string =>
	secure ? PRIVATE_SESSION_COOKIE_SECURE : PRIVATE_SESSION_COOKIE
export const PRIVATE_GRANT_QUERY_PARAM = 'g'
export const PRIVATE_SESSION_TTL_MINUTES = 60
export const OWNER_HANDOFF_TTL_SECONDS = 5 * 60

export type GrantKind = 'owner' | 'share'

export interface PrivateSessionRecord {
	sessionId: string
	siteId: string
	kind: GrantKind
	ownerDid: string | null
	shareId: string | null
	expiresAt: Date
	createdAt: Date
}

export interface GeneratedSecret {
	value: string
	hash: string
}

const generate = (prefix: string, bytes = 32): GeneratedSecret => {
	const value = `${prefix}${randomBytes(bytes).toString('base64url')}`
	return { value, hash: hashSecret(value) }
}

export const hashSecret = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
export const generateSessionSecret = (): GeneratedSecret => generate('wsx_')
export const generateHandoffSecret = (): GeneratedSecret => generate('wsh_')
export const secretsMatch = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false
	try {
		return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
	} catch {
		return false
	}
}
export const privateSiteHostname = (siteId: string, privateHost: string): string => `${siteId}.${privateHost}`
export const siteIdFromHostname = (hostname: string, privateHost: string): string | null => {
	const suffix = `.${privateHost}`
	if (!hostname.endsWith(suffix)) return null
	const label = hostname.slice(0, -suffix.length)
	if (label.length === 0 || label.includes('.')) return null
	return label
}
export const privateSiteUrl = (siteId: string, privateHost: string, scheme: 'http' | 'https'): string =>
	`${scheme}://${privateSiteHostname(siteId, privateHost)}/`
export const privateGrantUrlFor = (siteUrl: string, handoff: string): string =>
	`${siteUrl}?${PRIVATE_GRANT_QUERY_PARAM}=${encodeURIComponent(handoff)}`
export const privateShareLinkUrl = (siteUrl: string, token: string): string =>
	`${siteUrl}?${PRIVATE_SHARE_QUERY_PARAM}=${encodeURIComponent(token)}`
export const buildSessionCookie = (value: string, secure: boolean, maxAgeSeconds: number): string => {
	const parts = [
		`${sessionCookieName(secure)}=${value}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Lax',
		`Max-Age=${maxAgeSeconds}`,
	]
	if (secure) parts.push('Secure')
	return parts.join('; ')
}
export const clearSessionCookie = (secure: boolean): string => buildSessionCookie('', secure, 0)
