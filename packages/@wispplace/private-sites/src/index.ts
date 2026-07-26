export { PRIVATE_ACCESS_PAGE_STYLES } from './access-page-styles'
export type { EvaluateAccessInput } from './access-policy'
export { denialStatus, evaluateAccess, isExpired } from './access-policy'
export type { ResolveExpiryOptions } from './expiry'
export { InvalidExpiryError, resolveExpiry } from './expiry'
export type { GeneratedSecret, GrantKind, PrivateSessionRecord } from './grant'
export {
	buildSessionCookie,
	clearSessionCookie,
	generateHandoffSecret,
	generateSessionSecret,
	hashSecret,
	OWNER_HANDOFF_TTL_SECONDS,
	PRIVATE_GRANT_QUERY_PARAM,
	PRIVATE_SESSION_COOKIE,
	PRIVATE_SESSION_COOKIE_SECURE,
	PRIVATE_SESSION_TTL_MINUTES,
	privateGrantUrlFor,
	privateShareLinkUrl,
	privateSiteHostname,
	privateSiteUrl,
	secretsMatch,
	sessionCookieName,
	siteIdFromHostname,
} from './grant'
export { countCookieOccurrences, parseCookieHeader } from './session-cookie'
export {
	buildPrivateStorageKey,
	generateRecordId,
	generateSiteId,
	isValidSiteId,
	PRIVATE_STORAGE_PREFIX,
	privateResponseHeaders,
} from './site-id'
export type { GeneratedShareToken } from './token'
export {
	generateShareToken,
	hashShareTokenSync,
	redactToken,
	redactUrlForLog,
	SHARE_TOKEN_PREFIX,
	timingSafeEqualHex,
} from './token'
export type {
	AccessDecision,
	AccessDenialReason,
	AccessPrincipal,
	PrivateSite,
	PrivateSiteShare,
	ResolvedExpiry,
} from './types'
