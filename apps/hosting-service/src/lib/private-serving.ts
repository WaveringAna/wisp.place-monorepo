import { PRIVATE_SHARE_QUERY_PARAM } from '@wispplace/constants'
import { normalizeSitePath } from '@wispplace/fs-utils'
import { createLogger } from '@wispplace/observability'
import {
	buildPrivateStorageKey,
	buildSessionCookie,
	countCookieOccurrences,
	type GeneratedSecret,
	generateRecordId,
	generateSessionSecret,
	hashSecret,
	hashShareTokenSync,
	isValidSiteId,
	PRIVATE_ACCESS_PAGE_STYLES,
	PRIVATE_GRANT_QUERY_PARAM,
	PRIVATE_SESSION_TTL_MINUTES,
	parseCookieHeader,
	privateFormResponseHeaders,
	privateResponseHeaders,
	sessionCookieName,
} from '@wispplace/private-sites'
import { lookup } from 'mime-types'
import {
	type AuthorizedPrivateSite,
	exchangePrivateHandoff,
	exchangePrivateShareToken,
	loadAuthorizedPrivateSite,
	type PrivateSiteFile,
	touchShare,
} from './private-sites-db'
import { privateStorage } from './storage'

const logger = createLogger('hosting-service')

const INDEX_FILES = ['index.html', 'index.htm']

const isSecureRequest = (request: Request): boolean => {
	if (request.headers.get('x-forwarded-proto') === 'https') return true
	try {
		return new URL(request.url).protocol === 'https:'
	} catch {
		return false
	}
}
const mainAppOrigin = (): string => {
	const configured = process.env.MAIN_APP_URL || process.env.DOMAIN
	if (configured) return configured.replace(/\/+$/, '')
	const base = (process.env.BASE_HOST || 'wisp.place').split(':')[0]
	return `https://${base}`
}

const privatePageHead = (title: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} — wisp.place</title>
<style>${PRIVATE_ACCESS_PAGE_STYLES}</style></head>`
const scopedSignInPage = (siteId: string, token: string, audienceDid: string): Response => {
	const body = `${privatePageHead('sign in required')}
<body><main class="private-page private-shell">
<script>history.replaceState(null, '', location.pathname)</script>
<div class="private-brand"><strong>wisp.place</strong></div>
<h1>this link is for a specific account</h1>
<p>it was shared with <code>${escapeHtml(audienceDid)}</code>. sign in with that account to open it.</p>
<form class="private-form" method="POST" action="${escapeHtml(mainAppOrigin())}/private/redeem">
 <input type="hidden" name="siteId" value="${escapeHtml(siteId)}">
 <input type="hidden" name="token" value="${escapeHtml(token)}">
 <button class="private-action" type="submit">sign in with atproto <span aria-hidden="true">→</span></button>
</form>
</main></body></html>`

	// This page POSTs cross-origin to the main app, so it cannot send `no-referrer`.
	return new Response(body, {
		status: 200,
		headers: { ...privateFormResponseHeaders(), 'Content-Type': 'text/html; charset=utf-8' },
	})
}
const anonymousSignInPage = (siteId: string): Response => {
	// Keep this independent of database state so hostnames cannot be probed for existence.
	const body = `${privatePageHead('sign in')}
<body><main class="private-page private-shell">
<div class="private-brand"><strong>wisp.place</strong></div>
<p class="private-kicker">access required</p>
<h1>private site</h1>
<p>this address needs a share link, or an account with access to it.</p>
<form class="private-form" method="GET" action="${escapeHtml(mainAppOrigin())}/private/open">
 <input type="hidden" name="siteId" value="${escapeHtml(siteId)}">
 <button class="private-action" type="submit">sign in with atproto <span aria-hidden="true">→</span></button>
</form>
</main></body></html>`

	return new Response(body, {
		status: 200,
		headers: { ...privateResponseHeaders(), 'Content-Type': 'text/html; charset=utf-8' },
	})
}

const escapeHtml = (value: string): string =>
	value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
export const privateNotFound = (): Response =>
	new Response('Not found', {
		status: 404,
		headers: { ...privateResponseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' },
	})
type CredentialQuery = { kind: 'none' } | { kind: 'handoff'; token: string } | { kind: 'share'; token: string }

type PresentedCredential = Exclude<CredentialQuery, { kind: 'none' }>

type PendingSession = {
	sessionId: string
	secret: GeneratedSecret
	expiresAt: Date
}

type CredentialResolution =
	| { kind: 'sessionCreated'; pendingSession: PendingSession; shareId: string | null }
	| { kind: 'audienceMismatch'; shareToken: string; audienceDid: string }
	| { kind: 'denied'; source: 'handoff' | 'share' }
	| { kind: 'unavailable'; source: 'handoff' | 'share' }

type CredentialFailure = Exclude<CredentialResolution, { kind: 'sessionCreated' }>
type CredentialExchangeOutcome = { kind: 'notPresent' } | { kind: 'response'; response: Response }
type SessionCookieOutcome = { kind: 'missing' } | { kind: 'present'; secretHash: string }
type AuthorizedSiteLoadOutcome =
	| { kind: 'authorized'; authorized: AuthorizedPrivateSite }
	| { kind: 'missing' }
	| { kind: 'unavailable' }

type PrivateManifestOutcome = { kind: 'valid'; index: PrivateFileIndex } | { kind: 'invalid' }
type PrivateStorageReadOutcome = { kind: 'found'; bytes: Uint8Array } | { kind: 'missing' } | { kind: 'unavailable' }

interface PrivateFileIndex {
	known: Map<string, PrivateSiteFile>
	legacyRoot: string
}

const credentialQueryFrom = (url: URL): CredentialQuery => {
	const handoffToken = url.searchParams.get(PRIVATE_GRANT_QUERY_PARAM)
	if (handoffToken) return { kind: 'handoff', token: handoffToken }

	const shareToken = url.searchParams.get(PRIVATE_SHARE_QUERY_PARAM)
	return shareToken ? { kind: 'share', token: shareToken } : { kind: 'none' }
}

const newPendingSession = (): PendingSession => {
	const secret = generateSessionSecret()
	return {
		sessionId: generateRecordId(),
		secret,
		expiresAt: new Date(Date.now() + PRIVATE_SESSION_TTL_MINUTES * 60_000),
	}
}

const sessionRedirect = (request: Request, url: URL, secret: GeneratedSecret): Response => {
	url.searchParams.delete(PRIVATE_SHARE_QUERY_PARAM)
	url.searchParams.delete(PRIVATE_GRANT_QUERY_PARAM)
	return new Response(null, {
		status: 302,
		headers: {
			...privateResponseHeaders(),
			Location: `${url.pathname}${url.search}`,
			'Set-Cookie': buildSessionCookie(secret.value, isSecureRequest(request), PRIVATE_SESSION_TTL_MINUTES * 60),
		},
	})
}

const resolveHandoffCredential = async (siteId: string, token: string): Promise<CredentialResolution> => {
	const pendingSession = newPendingSession()
	const input = {
		siteId,
		secretHash: hashSecret(token),
		sessionId: pendingSession.sessionId,
		sessionSecretHash: pendingSession.secret.hash,
		expiresAt: pendingSession.expiresAt,
	}
	try {
		const exchange = await exchangePrivateHandoff(input)
		if (!exchange) return { kind: 'denied', source: 'handoff' }
		return {
			kind: 'sessionCreated',
			pendingSession,
			shareId: exchange.kind === 'share' ? exchange.shareId : null,
		}
	} catch {
		return { kind: 'unavailable', source: 'handoff' }
	}
}

const resolveShareCredential = async (siteId: string, token: string): Promise<CredentialResolution> => {
	const pendingSession = newPendingSession()
	const input = {
		siteId,
		tokenHash: hashShareTokenSync(token),
		sessionId: pendingSession.sessionId,
		sessionSecretHash: pendingSession.secret.hash,
		expiresAt: pendingSession.expiresAt,
	}
	try {
		const exchange = await exchangePrivateShareToken(input)
		if (!exchange) return { kind: 'denied', source: 'share' }
		if (exchange.kind === 'audienceMismatch') {
			return { kind: 'audienceMismatch', shareToken: token, audienceDid: exchange.audienceDid }
		}
		return { kind: 'sessionCreated', pendingSession, shareId: exchange.shareId }
	} catch {
		return { kind: 'unavailable', source: 'share' }
	}
}

const resolveCredential = (siteId: string, credential: PresentedCredential): Promise<CredentialResolution> => {
	return credential.kind === 'handoff'
		? resolveHandoffCredential(siteId, credential.token)
		: resolveShareCredential(siteId, credential.token)
}

const touchGrantedShare = (siteId: string, shareId: string): void => {
	void touchShare(shareId).catch(() => {
		logger.warn('[PrivateSite] Could not record share use', { siteId, failureKind: 'share-touch-failed' })
	})
}

const credentialFailureResponse = (siteId: string, resolution: CredentialFailure): Response => {
	if (resolution.kind === 'audienceMismatch') {
		logger.info('[PrivateSite] Scoped share needs sign-in', { siteId })
		return scopedSignInPage(siteId, resolution.shareToken, resolution.audienceDid)
	}

	if (resolution.kind === 'unavailable') {
		logger.warn('[PrivateSite] Credential exchange unavailable', {
			siteId,
			failureKind: `${resolution.source}-exchange-failed`,
		})
	} else {
		logger.info('[PrivateSite] Credential exchange denied', { siteId, source: resolution.source })
	}
	return privateNotFound()
}

const tryExchangeCredential = async (request: Request, siteId: string): Promise<CredentialExchangeOutcome> => {
	const url = new URL(request.url)
	const credential = credentialQueryFrom(url)
	if (credential.kind === 'none') return { kind: 'notPresent' }

	const resolution = await resolveCredential(siteId, credential)
	if (resolution.kind !== 'sessionCreated') {
		return { kind: 'response', response: credentialFailureResponse(siteId, resolution) }
	}

	if (resolution.shareId) touchGrantedShare(siteId, resolution.shareId)
	return { kind: 'response', response: sessionRedirect(request, url, resolution.pendingSession.secret) }
}

const sessionCookieFrom = (request: Request): SessionCookieOutcome => {
	const cookieHeader = request.headers.get('cookie')
	const name = sessionCookieName(isSecureRequest(request))
	// Refuse cookie-tossing ambiguity rather than relying on first/last-wins parsing.
	if (countCookieOccurrences(cookieHeader, name) !== 1) return { kind: 'missing' }

	const raw = parseCookieHeader(cookieHeader)[name]
	return raw ? { kind: 'present', secretHash: hashSecret(raw) } : { kind: 'missing' }
}

/**
 * The primary-only aggregate query is the session authorization boundary. It
 * returns files only when the site, session, and any backing share are live.
 */
const loadAuthorizedSite = async (siteId: string, secretHash: string): Promise<AuthorizedSiteLoadOutcome> => {
	try {
		const authorized = await loadAuthorizedPrivateSite(siteId, secretHash)
		return authorized ? { kind: 'authorized', authorized } : { kind: 'missing' }
	} catch {
		logger.warn('[PrivateSite] Authorized site lookup failed', { siteId, failureKind: 'authorized-site-load-failed' })
		return { kind: 'unavailable' }
	}
}

const invalidPrivatePathResponse = (): Response => {
	return new Response('Invalid path', {
		status: 400,
		headers: { ...privateResponseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' },
	})
}

const normalizedPrivateRequestPath = (filePath: string): { kind: 'valid'; path: string } | { kind: 'invalid' } => {
	const path = normalizeSitePath(filePath)
	return path === null ? { kind: 'invalid' } : { kind: 'valid', path }
}

const isCanonicalStoredPath = (path: string): boolean => {
	const normalized = normalizeSitePath(path)
	return normalized !== null && normalized.length > 0 && normalized === path
}

const indexPrivateFiles = (files: readonly PrivateSiteFile[]): PrivateFileIndex => {
	const known = new Map(files.map((file) => [file.path, file]))
	const firstSegments = new Set(files.map((file) => file.path.split('/')[0]))
	const legacyRoot =
		files.length > 0 && firstSegments.size === 1 && files.every((file) => file.path.includes('/'))
			? `${files[0]!.path.split('/')[0]}/`
			: ''
	return { known, legacyRoot }
}

const validateAndIndexPrivateFiles = (files: readonly PrivateSiteFile[]): PrivateManifestOutcome => {
	for (const file of files) {
		if (!isCanonicalStoredPath(file.path)) return { kind: 'invalid' }
	}
	return { kind: 'valid', index: indexPrivateFiles(files) }
}

const firstKnownIndex = (directory: string, known: ReadonlyMap<string, PrivateSiteFile>): string | null => {
	for (const indexFile of INDEX_FILES) {
		const candidate = `${directory}${indexFile}`
		if (known.has(candidate)) return candidate
	}
	return null
}

const targetWithinRoot = (
	requested: string,
	root: string,
	known: ReadonlyMap<string, PrivateSiteFile>,
): string | null => {
	const rootedRequest = `${root}${requested}`
	if (requested.length > 0 && known.has(rootedRequest)) return rootedRequest
	return firstKnownIndex(requested.length > 0 ? `${rootedRequest}/` : root, known)
}

const resolvePrivateTarget = (requested: string, index: PrivateFileIndex): string | null => {
	const target = targetWithinRoot(requested, '', index.known)
	if (target || !index.legacyRoot) return target
	return targetWithinRoot(requested, index.legacyRoot, index.known)
}

const loadPrivateFile = async (siteId: string, target: string): Promise<PrivateStorageReadOutcome> => {
	const storageKey = buildPrivateStorageKey(siteId, target)
	try {
		const result = await privateStorage.get(storageKey)
		return result ? { kind: 'found', bytes: result as Uint8Array } : { kind: 'missing' }
	} catch {
		return { kind: 'unavailable' }
	}
}

const privateFileResponse = (target: string, bytes: Uint8Array, meta: PrivateSiteFile | undefined): Response => {
	return new Response(Buffer.from(bytes), {
		status: 200,
		headers: {
			...privateResponseHeaders(),
			'Content-Type': meta?.mimeType ?? (lookup(target) || 'application/octet-stream'),
			'Content-Length': String(bytes.byteLength),
		},
	})
}

const servePrivateStoredFile = async (siteId: string, target: string, index: PrivateFileIndex): Promise<Response> => {
	const stored = await loadPrivateFile(siteId, target)
	if (stored.kind === 'missing') {
		logger.warn('[PrivateSite] Stored file missing', { siteId, path: target })
		return privateNotFound()
	}
	if (stored.kind === 'unavailable') {
		logger.warn('[PrivateSite] Stored file unavailable', {
			siteId,
			path: target,
			failureKind: 'private-storage-read-failed',
		})
		return privateNotFound()
	}
	return privateFileResponse(target, stored.bytes, index.known.get(target))
}

export const servePrivateSite = async (request: Request, siteId: string, filePath: string): Promise<Response> => {
	if (!isValidSiteId(siteId)) return privateNotFound()

	const requested = normalizedPrivateRequestPath(filePath)
	if (requested.kind === 'invalid') return invalidPrivatePathResponse()

	const exchanged = await tryExchangeCredential(request, siteId)
	if (exchanged.kind === 'response') return exchanged.response

	const session = sessionCookieFrom(request)
	if (session.kind === 'missing') return anonymousSignInPage(siteId)

	const authorized = await loadAuthorizedSite(siteId, session.secretHash)
	if (authorized.kind === 'unavailable') return privateNotFound()
	if (authorized.kind === 'missing') return anonymousSignInPage(siteId)

	const manifest = validateAndIndexPrivateFiles(authorized.authorized.files)
	if (manifest.kind === 'invalid') return privateNotFound()

	const target = resolvePrivateTarget(requested.path, manifest.index)
	if (!target) return privateNotFound()
	return await servePrivateStoredFile(siteId, target, manifest.index)
}
