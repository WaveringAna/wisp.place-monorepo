/**
 * Serving of private sites.
 *
 * Isolation model:
 *   - each private site is served from its **own origin**, `<siteId>.priv.<baseHost>`, so
 *     one tenant's JavaScript cannot read another tenant's content same-origin, and a
 *     session cookie for one site is never sent to another
 *   - the account session cookie from main-app is NOT accepted here at all; owners arrive
 *     through a single-use handoff token instead
 *   - a URL credential (share token or owner handoff) is exchanged once for a host-only,
 *     short-lived session cookie, then the URL is redirected clean. Subresources such as
 *     CSS, scripts, and images carry that cookie automatically, which a query-string
 *     credential cannot do
 *   - every denial renders an identical 404, and credentials are never logged
 */

import { PRIVATE_SHARE_QUERY_PARAM } from '@wispplace/constants'
import { sanitizePath } from '@wispplace/fs-utils'
import { createLogger } from '@wispplace/observability'
import {
	type AccessPrincipal,
	buildPrivateStorageKey,
	buildSessionCookie,
	evaluateAccess,
	generateSessionSecret,
	generateSiteId,
	hashSecret,
	hashShareTokenSync,
	isValidSiteId,
	PRIVATE_GRANT_QUERY_PARAM,
	PRIVATE_SESSION_COOKIE,
	PRIVATE_SESSION_TTL_MINUTES,
	parseCookieHeader,
	privateResponseHeaders,
} from '@wispplace/private-sites'
import {
	consumeHandoff,
	createSession,
	findLiveSession,
	findSharesByTokenHash,
	getPrivateSite,
	listPrivateSiteFiles,
	touchShare,
} from './private-sites-db'
import { privateStorage } from './storage'

const logger = createLogger('hosting-service')

const INDEX_FILES = ['index.html', 'index.htm']

const MIME_BY_EXT: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	htm: 'text/html; charset=utf-8',
	css: 'text/css; charset=utf-8',
	js: 'text/javascript; charset=utf-8',
	json: 'application/json',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	ico: 'image/x-icon',
	txt: 'text/plain; charset=utf-8',
	woff2: 'font/woff2',
}

const guessMimeType = (path: string): string => {
	const ext = path.split('.').pop()?.toLowerCase() ?? ''
	return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

const isSecureRequest = (request: Request): boolean => {
	if (request.headers.get('x-forwarded-proto') === 'https') return true
	try {
		return new URL(request.url).protocol === 'https:'
	} catch {
		return false
	}
}

/** Uniform not-found response for every denial and every miss. */
export const privateNotFound = (): Response =>
	new Response('Not found', {
		status: 404,
		headers: { ...privateResponseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' },
	})

/**
 * Exchange a URL credential for a site-scoped session and redirect to a clean URL.
 *
 * Returns null when no credential was presented, so the caller can fall through to an
 * existing session cookie.
 */
const tryExchangeCredential = async (request: Request, siteId: string): Promise<Response | null> => {
	const url = new URL(request.url)
	const shareToken = url.searchParams.get(PRIVATE_SHARE_QUERY_PARAM)
	const handoffToken = url.searchParams.get(PRIVATE_GRANT_QUERY_PARAM)

	if (!shareToken && !handoffToken) return null

	let kind: 'owner' | 'share'
	let ownerDid: string | null = null
	let shareId: string | null = null

	if (handoffToken) {
		// Single-use owner handoff minted by main-app for an authenticated owner.
		const consumed = await consumeHandoff(hashSecret(handoffToken))
		if (!consumed || consumed.siteId !== siteId) {
			logger.info('[PrivateSite] Handoff rejected', { siteId })
			return privateNotFound()
		}
		kind = 'owner'
		ownerDid = consumed.ownerDid
	} else {
		const site = await getPrivateSite(siteId)
		const shares = await findSharesByTokenHash(siteId, hashShareTokenSync(shareToken!))
		const decision = evaluateAccess({
			site,
			shares,
			principal: { kind: 'shareToken', token: shareToken! },
			now: new Date(),
		})
		if (!decision.allowed) {
			logger.info('[PrivateSite] Share exchange denied', { siteId, reason: decision.reason })
			return privateNotFound()
		}
		kind = 'share'
		shareId = decision.reason === 'share' ? decision.shareId : null
		if (shareId) void touchShare(shareId)
	}

	const secret = generateSessionSecret()
	const expiresAt = new Date(Date.now() + PRIVATE_SESSION_TTL_MINUTES * 60_000)
	await createSession({
		sessionId: generateSiteId(),
		secretHash: secret.hash,
		siteId,
		kind,
		ownerDid,
		shareId,
		expiresAt,
	})

	// Strip the credential from the URL so it stops appearing in history, referrers, and
	// any downstream log that records paths with query strings.
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

/**
 * Resolve an existing site session from the host-only cookie.
 *
 * The session must belong to this exact site, so a cookie leaked from one private origin
 * cannot authorize another.
 */
const principalFromSession = async (request: Request, siteId: string): Promise<AccessPrincipal | null> => {
	const cookies = parseCookieHeader(request.headers.get('cookie'))
	const raw = cookies[PRIVATE_SESSION_COOKIE]
	if (!raw) return null

	const session = await findLiveSession(hashSecret(raw))
	if (!session || session.siteId !== siteId) return null

	if (session.kind === 'owner' && session.ownerDid) {
		return { kind: 'owner', did: session.ownerDid }
	}
	// A live share-backed session already passed share validation at exchange time, and
	// `findLiveSession` re-checks revocation and expiry on every request.
	return { kind: 'sessionShare' } as AccessPrincipal
}

/**
 * Serve a path from a private site.
 *
 * `siteId` comes from the request's own hostname, so it is not attacker-chosen relative to
 * the origin the browser is enforcing.
 */
export const servePrivateSite = async (request: Request, siteId: string, filePath: string): Promise<Response> => {
	if (!isValidSiteId(siteId)) return privateNotFound()

	const site = await getPrivateSite(siteId)
	if (!site) return privateNotFound()

	// A credential in the URL is exchanged for a cookie and redirected away.
	const exchanged = await tryExchangeCredential(request, siteId)
	if (exchanged) return exchanged

	const principal = await principalFromSession(request, siteId)
	if (!principal) {
		logger.info('[PrivateSite] Access denied', { siteId, reason: 'noSession' })
		return privateNotFound()
	}

	// Owner sessions still run the policy so site expiry and ownership are re-checked.
	if (principal.kind === 'owner') {
		const decision = evaluateAccess({ site, shares: [], principal, now: new Date() })
		if (!decision.allowed) {
			logger.info('[PrivateSite] Access denied', { siteId, reason: decision.reason, principal: principal.kind })
			return privateNotFound()
		}
	} else if (new Date(site.expiresAt ?? Number.MAX_SAFE_INTEGER) <= new Date()) {
		// Share-backed sessions close as soon as the site itself expires.
		logger.info('[PrivateSite] Access denied', { siteId, reason: 'siteExpired' })
		return privateNotFound()
	}

	const requested = sanitizePath(filePath.replace(/\/+$/, ''))
	const files = await listPrivateSiteFiles(siteId)
	const known = new Map(files.map((f) => [f.path, f]))

	let target: string | null = null
	if (requested.length > 0 && known.has(requested)) {
		target = requested
	} else {
		for (const index of INDEX_FILES) {
			const candidate = requested.length > 0 ? `${requested}/${index}` : index
			if (known.has(candidate)) {
				target = candidate
				break
			}
		}
	}

	if (!target) return privateNotFound()

	// Cold-only storage: private bytes are never promoted into the shared hot/warm caches
	// used for public site serving.
	const result = await privateStorage.get(buildPrivateStorageKey(siteId, target))
	if (!result) {
		logger.warn('[PrivateSite] Stored file missing', { siteId, path: target })
		return privateNotFound()
	}

	const bytes = result as Uint8Array
	const meta = known.get(target)

	return new Response(bytes as unknown as BodyInit, {
		status: 200,
		headers: {
			...privateResponseHeaders(),
			'Content-Type': meta?.mimeType ?? guessMimeType(target),
			'Content-Length': String(bytes.byteLength),
		},
	})
}
