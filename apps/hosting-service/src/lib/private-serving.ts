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
 *   - anonymous requests to a well-formed private hostname render the same sign-in page,
 *     whether or not that site exists; failed credentials still render an identical 404
 *   - credentials are never logged
 */

import { PRIVATE_SHARE_QUERY_PARAM } from '@wispplace/constants'
import { sanitizePath } from '@wispplace/fs-utils'
import { createLogger } from '@wispplace/observability'
import {
	type AccessPrincipal,
	buildPrivateStorageKey,
	buildSessionCookie,
	evaluateAccess,
	generateRecordId,
	generateSessionSecret,
	hashSecret,
	hashShareTokenSync,
	isValidSiteId,
	PRIVATE_ACCESS_PAGE_STYLES,
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

/**
 * Where main-app lives, for the identity bounce.
 *
 * Only ever used to build a link shown to someone who already presented a valid share
 * token, so it never reveals a private site to an anonymous visitor.
 */
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

/**
 * Sign-in interstitial for a share that is scoped to a specific DID.
 *
 * The private origins deliberately cannot read the account cookie, so identity has to be
 * proven on main-app and handed back.
 *
 * This is a plain form POST — a top-level navigation, not a `fetch`. That is deliberate:
 * a credentialed XHR would require main-app to allow CORS from `*.priv.<host>`, and those
 * origins serve untrusted user-uploaded JavaScript. Opening that would let a private
 * site's own script read the owner's main-app API. A navigation needs no CORS, and the
 * token travels in the POST body rather than the URL, so it never reaches a `Referer`
 * header, a history entry, or a request log.
 *
 * Only ever rendered to someone who already presented a valid share token; every other
 * denial is an indistinguishable 404.
 */
const scopedSignInPage = (siteId: string, token: string, audienceDid: string): Response => {
	const body = `${privatePageHead('sign in required')}
<body><main class="private-page private-shell">
<div class="private-brand"><strong>wisp.place</strong><span>private access</span></div>
<p class="private-kicker">account access</p>
<h1>this link is for a specific account</h1>
<p>it was shared with <code>${escapeHtml(audienceDid)}</code>. sign in with that account to open it.</p>
<form class="private-form" method="POST" action="${escapeHtml(mainAppOrigin())}/private/redeem">
 <input type="hidden" name="siteId" value="${escapeHtml(siteId)}">
 <input type="hidden" name="token" value="${escapeHtml(token)}">
 <button class="private-action" type="submit">sign in with atproto <span aria-hidden="true">→</span></button>
</form>
<p class="private-note">your password stays with your personal data server. wisp only starts the sign-in handoff.</p>
</main></body></html>`

	return new Response(body, {
		status: 200,
		headers: { ...privateResponseHeaders(), 'Content-Type': 'text/html; charset=utf-8' },
	})
}

/**
 * Sign-in page shown when a visitor presents no credential at all.
 *
 * This is how an owner opens their own site by typing its hostname: the private origin
 * cannot read the account cookie, so the visitor proves who they are on main-app and comes
 * back with a handoff.
 *
 * **This response must be byte-identical for a given well-formed site id whether or not the
 * site exists.** If it ever varied based on existence, a stranger could probe hostnames to
 * discover which private sites are real. Returning 200 does not weaken that property: every
 * well-formed private hostname and every path receives the same page. The site id travels in
 * the form body, and main-app answers identically for an unknown site and for one the viewer
 * cannot access.
 */
const anonymousSignInPage = (siteId: string): Response => {
	const body = `${privatePageHead('sign in')}
<body><main class="private-page private-shell">
<div class="private-brand"><strong>wisp.place</strong><span>private access</span></div>
<p class="private-kicker">access required</p>
<h1>private site</h1>
<p>this address needs a share link, or an account with access to it.</p>
<form class="private-form" method="GET" action="${escapeHtml(mainAppOrigin())}/private/open">
 <input type="hidden" name="siteId" value="${escapeHtml(siteId)}">
 <button class="private-action" type="submit">sign in with atproto <span aria-hidden="true">→</span></button>
</form>
<p class="private-note">your password stays with your personal data server. wisp only starts the sign-in handoff.</p>
</main></body></html>`

	return new Response(body, {
		status: 200,
		headers: { ...privateResponseHeaders(), 'Content-Type': 'text/html; charset=utf-8' },
	})
}

const escapeHtml = (value: string): string =>
	value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

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
		// Single-use handoff minted by main-app: either an owner crossing origins, or a
		// DID-scoped share redeemed after the identity bounce. main-app has already made
		// the access decision in both cases; consuming the row is what proves it.
		const consumed = await consumeHandoff(hashSecret(handoffToken))
		if (!consumed || consumed.siteId !== siteId) {
			logger.info('[PrivateSite] Handoff rejected', { siteId })
			return privateNotFound()
		}
		if (consumed.ownerDid) {
			kind = 'owner'
			ownerDid = consumed.ownerDid
		} else if (consumed.shareId) {
			// Bound to the share, so revoking it kills the resulting session immediately.
			kind = 'share'
			shareId = consumed.shareId
			void touchShare(shareId)
		} else {
			logger.info('[PrivateSite] Handoff carried no grant', { siteId })
			return privateNotFound()
		}
	} else {
		const site = await getPrivateSite(siteId)
		const shares = await findSharesByTokenHash(siteId, hashShareTokenSync(shareToken!))
		const decision = evaluateAccess({
			site,
			shares,
			principal: { kind: 'shareToken', token: shareToken! },
			now: new Date(),
		})
		// A DID-scoped share whose holder is not signed in as that DID gets the sign-in
		// bounce instead of a 404. Reaching this branch already required a valid token, so
		// it cannot be used to discover that a private site exists.
		if (!decision.allowed && decision.reason === 'audienceMismatch') {
			logger.info('[PrivateSite] Scoped share needs sign-in', { siteId })
			return scopedSignInPage(siteId, shareToken!, decision.audienceDid)
		}
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
		sessionId: generateRecordId(),
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

	// A credential in the URL is exchanged for a cookie and redirected away. Runs before
	// the existence check so a bad credential and a missing site are indistinguishable.
	const exchanged = site ? await tryExchangeCredential(request, siteId) : null
	if (exchanged) return exchanged

	const principal = site ? await principalFromSession(request, siteId) : null
	if (!principal) {
		// The private origin cannot read the main-app account cookie, so every anonymous path
		// offers the same owner/share sign-in handoff. This is deliberately rendered for any
		// well-formed site id, existing or not: neither status, headers, nor body reveal whether
		// a site or requested file exists, and no private bytes are read before authorization.
		return anonymousSignInPage(siteId)
	}
	if (!site) return privateNotFound()

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
	// Early editor builds retained the selected directory name (`dist/index.html`) while
	// public uploads treated that directory as the site root. Keep those existing uploads
	// usable, including their absolute `/assets/...` references. New editor uploads are
	// normalized during ingestion.
	const firstSegments = new Set(files.map((file) => file.path.split('/')[0]))
	const legacyRoot =
		files.length > 0 && firstSegments.size === 1 && files.every((file) => file.path.includes('/'))
			? `${files[0]!.path.split('/')[0]}/`
			: ''

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

	if (!target && legacyRoot) {
		const rootedRequest = `${legacyRoot}${requested}`
		if (requested.length > 0 && known.has(rootedRequest)) {
			target = rootedRequest
		} else {
			for (const index of INDEX_FILES) {
				const candidate = requested.length > 0 ? `${rootedRequest}/${index}` : `${legacyRoot}${index}`
				if (known.has(candidate)) {
					target = candidate
					break
				}
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
