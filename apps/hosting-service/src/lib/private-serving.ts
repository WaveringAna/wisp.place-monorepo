import { PRIVATE_SHARE_QUERY_PARAM } from '@wispplace/constants'
import { sanitizePath } from '@wispplace/fs-utils'
import { createLogger } from '@wispplace/observability'
import {
	type AccessPrincipal,
	buildPrivateStorageKey,
	buildSessionCookie,
	countCookieOccurrences,
	evaluateAccess,
	generateRecordId,
	generateSessionSecret,
	hashSecret,
	hashShareTokenSync,
	isValidSiteId,
	PRIVATE_ACCESS_PAGE_STYLES,
	PRIVATE_GRANT_QUERY_PARAM,
	PRIVATE_SESSION_TTL_MINUTES,
	parseCookieHeader,
	privateResponseHeaders,
	sessionCookieName,
} from '@wispplace/private-sites'
import { lookup } from 'mime-types'
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

	return new Response(body, {
		status: 200,
		headers: { ...privateResponseHeaders(), 'Content-Type': 'text/html; charset=utf-8' },
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
const tryExchangeCredential = async (request: Request, siteId: string): Promise<Response | null> => {
	const url = new URL(request.url)
	const shareToken = url.searchParams.get(PRIVATE_SHARE_QUERY_PARAM)
	const handoffToken = url.searchParams.get(PRIVATE_GRANT_QUERY_PARAM)

	if (!shareToken && !handoffToken) return null

	let kind: 'owner' | 'share'
	let ownerDid: string | null = null
	let shareId: string | null = null

	if (handoffToken) {
		const consumed = await consumeHandoff(hashSecret(handoffToken), siteId)
		if (!consumed) {
			logger.info('[PrivateSite] Handoff rejected', { siteId })
			return privateNotFound()
		}
		if (consumed.ownerDid) {
			kind = 'owner'
			ownerDid = consumed.ownerDid
		} else if (consumed.shareId) {
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
const principalFromSession = async (request: Request, siteId: string): Promise<AccessPrincipal | null> => {
	const cookieHeader = request.headers.get('cookie')
	const name = sessionCookieName(isSecureRequest(request))
	// Refuse cookie-tossing ambiguity rather than relying on first/last-wins parsing.
	if (countCookieOccurrences(cookieHeader, name) !== 1) return null

	const cookies = parseCookieHeader(cookieHeader)
	const raw = cookies[name]
	if (!raw) return null

	const session = await findLiveSession(hashSecret(raw))
	if (!session || session.siteId !== siteId) return null

	if (session.kind === 'owner' && session.ownerDid) {
		return { kind: 'owner', did: session.ownerDid }
	}
	return session.shareId ? { kind: 'sessionShare', shareId: session.shareId } : null
}
export const servePrivateSite = async (request: Request, siteId: string, filePath: string): Promise<Response> => {
	if (!isValidSiteId(siteId)) return privateNotFound()

	const site = await getPrivateSite(siteId)
	if (!site) {
		const probe = new URL(request.url)
		if (probe.searchParams.has(PRIVATE_SHARE_QUERY_PARAM) || probe.searchParams.has(PRIVATE_GRANT_QUERY_PARAM)) {
			return privateNotFound()
		}
	}
	const exchanged = site ? await tryExchangeCredential(request, siteId) : null
	if (exchanged) return exchanged

	const principal = site ? await principalFromSession(request, siteId) : null
	if (!principal) {
		return anonymousSignInPage(siteId)
	}
	if (!site) return privateNotFound()

	const decision = evaluateAccess({ site, shares: [], principal, now: new Date() })
	if (!decision.allowed) {
		logger.info('[PrivateSite] Access denied', { siteId, reason: decision.reason, principal: principal.kind })
		return privateNotFound()
	}

	const requested = sanitizePath(filePath.replace(/\/+$/, ''))
	const files = await listPrivateSiteFiles(siteId)
	const known = new Map(files.map((f) => [f.path, f]))
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
			'Content-Type': meta?.mimeType ?? (lookup(target) || 'application/octet-stream'),
			'Content-Length': String(bytes.byteLength),
		},
	})
}
