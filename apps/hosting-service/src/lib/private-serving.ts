/**
 * Serving of private sites on the dedicated private host.
 *
 * Isolation rules enforced here:
 *   - this handler is only reachable on the private host (`priv.<base host>`), which never
 *     serves user-uploaded public site content, so a public site cannot use an ambient
 *     session to read private responses same-origin
 *   - the account session cookie is honoured ONLY on that host; presented anywhere else it
 *     grants nothing
 *   - every denial renders an identical 404, so probing cannot distinguish an existing
 *     private site from a missing one
 *   - responses are `no-store` and `noindex`, and the share credential is never logged
 */

import { PRIVATE_SHARE_QUERY_PARAM } from '@wispplace/constants'
import { sanitizePath } from '@wispplace/fs-utils'
import { createLogger } from '@wispplace/observability'
import {
	type AccessPrincipal,
	buildPrivateStorageKey,
	evaluateAccess,
	hashShareTokenSync,
	isValidSiteId,
	privateResponseHeaders,
	readSessionDid,
} from '@wispplace/private-sites'
import { getCookieSecrets } from './cookie-secrets'
import { findSharesByTokenHash, getPrivateSite, listPrivateSiteFiles, touchShare } from './private-sites-db'
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

/**
 * Uniform not-found response for every denial and every miss.
 *
 * Identical bytes, status, and headers regardless of whether the site is missing, expired,
 * revoked, or simply not authorized for this requester.
 */
export const privateNotFound = (): Response =>
	new Response('Not found', {
		status: 404,
		headers: { ...privateResponseHeaders(), 'Content-Type': 'text/plain; charset=utf-8' },
	})

/**
 * Build the access principal from request transport.
 *
 * A presented share token takes precedence over a session, so an owner can open their own
 * share link to see exactly what a recipient sees.
 */
const buildPrincipal = async (request: Request): Promise<AccessPrincipal> => {
	const url = new URL(request.url)
	const shareToken = url.searchParams.get(PRIVATE_SHARE_QUERY_PARAM)
	if (shareToken) {
		return { kind: 'shareToken', token: shareToken }
	}

	const secrets = await getCookieSecrets()
	const did = secrets.length > 0 ? readSessionDid(request.headers.get('cookie'), secrets) : null
	if (did) {
		return { kind: 'owner', did }
	}

	return { kind: 'anonymous' }
}

/**
 * Serve a path from a private site.
 *
 * `siteId` and `filePath` come from the private host's own path parsing; this function
 * performs the authorization check before touching storage.
 */
export const servePrivateSite = async (request: Request, siteId: string, filePath: string): Promise<Response> => {
	if (!isValidSiteId(siteId)) {
		return privateNotFound()
	}

	const site = await getPrivateSite(siteId)
	if (!site) {
		return privateNotFound()
	}

	const principal = await buildPrincipal(request)
	const shares =
		principal.kind === 'shareToken' ? await findSharesByTokenHash(siteId, hashShareTokenSync(principal.token)) : []

	const decision = evaluateAccess({ site, shares, principal, now: new Date() })

	if (!decision.allowed) {
		// Logs the reason and the site id only. The presented credential and the query
		// string are never logged.
		logger.info('[PrivateSite] Access denied', {
			siteId,
			reason: decision.reason,
			principal: principal.kind,
		})
		return privateNotFound()
	}

	if (decision.reason === 'share') {
		void touchShare(decision.shareId)
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

	if (!target) {
		return privateNotFound()
	}

	// `privateStorage` is cold-only, so private bytes are never promoted into the shared
	// hot/warm caches that public site serving uses.
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
