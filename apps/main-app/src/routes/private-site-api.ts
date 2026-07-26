/**
 * Session-authenticated REST endpoints for private sites, used by the editor UI.
 *
 * The XRPC methods in `xrpc-private-site.ts` are authenticated with service-auth JWTs and
 * are what the CLI uses. The browser holds a session cookie instead, so the UI gets these
 * cookie-authed equivalents rather than minting a service token in the frontend.
 *
 * Both surfaces delegate to the same service layer, so the authorization rules and expiry
 * semantics cannot drift between them.
 */

import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { createLogger } from '@wispplace/observability'
import { InvalidExpiryError, isExpired } from '@wispplace/private-sites'
import { Elysia } from 'elysia'
import { privateSiteUrl, shortShareUrl } from '../lib/private-site-origin'
import { PrivateSiteUploadError, readPrivateSiteUpload } from '../lib/private-site-upload'
import { createOwnerHandoff, listShares } from '../lib/private-sites-db'
import {
	createSiteShare,
	deleteOwnedPrivateSite,
	ingestPrivateSite,
	listOwnedPrivateSites,
	listSiteShares,
	PrivateSiteError,
	requireOwnedSite,
	revokeSiteShare,
} from '../lib/private-sites-service'
import { SlingshotHandleResolver } from '../lib/slingshot-handle-resolver'
import { requireAuth } from '../lib/wisp-auth'
import { privateOwnerUrl, privateShareUrl } from './xrpc-private-site'

const logger = createLogger('main-app')

const handleResolver = new SlingshotHandleResolver()

const shareStatus = (share: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): string => {
	if (share.revokedAt !== null) return 'revoked'
	if (isExpired(share.expiresAt, now)) return 'expired'
	return 'active'
}

const errorResponse = (err: unknown, set: { status?: number | string }) => {
	if (err instanceof PrivateSiteError) {
		set.status = err.code === 'notFound' ? 404 : err.code === 'tooLarge' ? 413 : 400
		return { success: false, error: err.message }
	}
	if (err instanceof InvalidExpiryError) {
		set.status = 400
		return { success: false, error: err.message }
	}
	if (err instanceof PrivateSiteUploadError) {
		set.status = err.status
		return { success: false, error: err.message }
	}
	set.status = 500
	return { success: false, error: 'Unexpected error' }
}

export const privateSiteApiRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/api/user/private-sites',
		cookie: { secrets: cookieSecret, sign: ['did'] },
	})
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
		/**
		 * GET /api/user/private-sites
		 * Only ever returns private sites owned by the authenticated account.
		 */
		.get('/', async ({ auth, set }) => {
			try {
				const now = new Date()
				const sites = await listOwnedPrivateSites(auth.did)

				const withShares = await Promise.all(
					sites.map(async (site) => {
						const shares = await listShares(site.siteId)
						return {
							siteId: site.siteId,
							name: site.name,
							fileCount: site.fileCount,
							totalBytes: site.totalBytes,
							expiresAt: site.expiresAt ? site.expiresAt.toISOString() : null,
							createdAt: site.createdAt.toISOString(),
							expired: isExpired(site.expiresAt, now),
							shareCount: shares.filter((s) => shareStatus(s, now) === 'active').length,
							url: privateSiteUrl(site.siteId),
						}
					}),
				)

				return { sites: withShares }
			} catch (err) {
				logger.error('[PrivateSite] List error', err)
				return errorResponse(err, set)
			}
		})
		/**
		 * POST /api/user/private-sites
		 *
		 * Cookie-authenticated equivalent of place.wisp.v2.privateSite.create for the editor.
		 * The upload is ingested directly into private storage and never reaches the PDS.
		 */
		.post(
			'/',
			async ({ request, auth, set }) => {
				try {
					// Directory pickers send `folder/index.html`; the selected folder is the site
					// root, matching the existing public-upload behaviour.
					const { name, expiryMinutes, files } = await readPrivateSiteUpload(request, { stripSharedRoot: true })
					const site = await ingestPrivateSite({ ownerDid: auth.did, name, expiryMinutes, files })

					return {
						success: true,
						siteId: site.siteId,
						name: site.name,
						fileCount: site.fileCount,
						totalBytes: site.totalBytes,
						expiresAt: site.expiresAt ? site.expiresAt.toISOString() : null,
						createdAt: site.createdAt.toISOString(),
						url: privateSiteUrl(site.siteId),
					}
				} catch (err) {
					logger.error('[PrivateSite] Create error', err)
					return errorResponse(err, set)
				}
			},
			// Multipart parsing is shared with XRPC, so keep Elysia from consuming the body first.
			{ parse: 'none' },
		)
		/**
		 * POST /api/user/private-sites/:siteId/open
		 *
		 * Mints a single-use, short-lived handoff token and returns the URL that exchanges it
		 * for a session on the site's own origin. The account session cookie is host-only to
		 * main-app and is deliberately not accepted by the private hosts, so ownership is
		 * proven here once and handed over explicitly.
		 */
		.post('/:siteId/open', async ({ params, auth, set }) => {
			try {
				const site = await requireOwnedSite(params.siteId, auth.did)
				const handoff = await createOwnerHandoff(site.siteId, auth.did)
				return { success: true, url: privateOwnerUrl(site.siteId, handoff) }
			} catch (err) {
				logger.error('[PrivateSite] Owner open error', err)
				return errorResponse(err, set)
			}
		})
		/**
		 * GET /api/user/private-sites/resolve-handle?handle=...
		 *
		 * Resolve a handle to a DID for the share-with-account field, so the editor can show
		 * who a link will be scoped to before creating it.
		 *
		 * Session-authenticated because it proxies an outbound lookup; that keeps it from
		 * becoming an open resolver for anonymous callers.
		 */
		.get('/resolve-handle', async ({ query, set }) => {
			const raw = typeof query.handle === 'string' ? query.handle.trim().replace(/^@/, '') : ''
			// Cheap shape check first so obvious typing noise never leaves the server.
			if (!raw || raw.length > 253 || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) {
				return { found: false }
			}

			try {
				const did = await handleResolver.resolve(raw)
				return did ? { found: true, handle: raw, did } : { found: false }
			} catch (err) {
				logger.warn('[PrivateSite] Handle resolve failed', { handle: raw })
				return errorResponse(err, set)
			}
		})
		/**
		 * GET /api/user/private-sites/:siteId/shares
		 * Never returns share tokens, only their non-secret display prefix.
		 */
		.get('/:siteId/shares', async ({ params, auth, set }) => {
			try {
				const now = new Date()
				const shares = await listSiteShares(params.siteId, auth.did)

				return {
					shares: shares.map((share) => ({
						shareId: share.shareId,
						tokenPrefix: share.tokenPrefix,
						label: share.label,
						audienceDid: share.audienceDid,
						expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
						revokedAt: share.revokedAt ? share.revokedAt.toISOString() : null,
						createdAt: share.createdAt.toISOString(),
						lastUsedAt: share.lastUsedAt ? share.lastUsedAt.toISOString() : null,
						status: shareStatus(share, now),
					})),
				}
			} catch (err) {
				logger.error('[PrivateSite] List shares error', err)
				return errorResponse(err, set)
			}
		})
		/**
		 * POST /api/user/private-sites/:siteId/shares
		 * The response contains the only copy of the credential that will ever exist.
		 */
		.post('/:siteId/shares', async ({ params, body, auth, set }) => {
			try {
				const input = (body ?? {}) as { label?: string; expiryMinutes?: number | null; audienceDid?: string }
				const { share, token } = await createSiteShare({
					siteId: params.siteId,
					ownerDid: auth.did,
					label: input.label ?? null,
					expiryMinutes: input.expiryMinutes,
					audienceDid: input.audienceDid ?? null,
				})

				return {
					success: true,
					shareId: share.shareId,
					audienceDid: share.audienceDid,
					// Returned once. Not persisted in this form and not retrievable later.
					url: shortShareUrl(token),
					directUrl: privateShareUrl(share.siteId, token),
					expiresAt: share.expiresAt ? share.expiresAt.toISOString() : null,
					createdAt: share.createdAt.toISOString(),
				}
			} catch (err) {
				logger.error('[PrivateSite] Create share error', err)
				return errorResponse(err, set)
			}
		})
		/**
		 * DELETE /api/user/private-sites/:siteId/shares/:shareId
		 */
		.delete('/:siteId/shares/:shareId', async ({ params, auth, set }) => {
			try {
				await revokeSiteShare(params.siteId, auth.did, params.shareId)
				return { success: true }
			} catch (err) {
				logger.error('[PrivateSite] Revoke share error', err)
				return errorResponse(err, set)
			}
		})
		/**
		 * DELETE /api/user/private-sites/:siteId
		 */
		.delete('/:siteId', async ({ params, auth, set }) => {
			try {
				await deleteOwnedPrivateSite(params.siteId, auth.did)
				return { success: true }
			} catch (err) {
				logger.error('[PrivateSite] Delete error', err)
				return errorResponse(err, set)
			}
		})
