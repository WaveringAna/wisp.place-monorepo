import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { createLogger } from '@wispplace/observability'
import { InvalidExpiryError, isExpired } from '@wispplace/private-sites'
import { Elysia } from 'elysia'
import { privateOwnerUrl, privateShareUrl, privateSiteUrl, shortShareUrl } from '../lib/private-site-origin'
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
import { requireAuth, SESSION_COOKIE_NAME } from '../lib/wisp-auth'

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
		cookie: { secrets: cookieSecret, sign: [SESSION_COOKIE_NAME] },
	})
		.derive(async ({ cookie, request }) => {
			const auth = await requireAuth(client, cookie, request.headers.get('cookie'))
			return { auth }
		})
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
		.post(
			'/',
			async ({ request, auth, set }) => {
				try {
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
			{ parse: 'none' },
		)
		.post('/:siteId/open', async ({ params, auth, set }) => {
			try {
				const site = await requireOwnedSite(params.siteId, auth.did)
				const handoff = await createOwnerHandoff(site.siteId, auth.did)
				if (!handoff) throw new PrivateSiteError('private site not found', 'notFound')
				return { success: true, url: privateOwnerUrl(site.siteId, handoff) }
			} catch (err) {
				logger.error('[PrivateSite] Owner open error', err)
				return errorResponse(err, set)
			}
		})
		.get('/resolve-handle', async ({ query, set }) => {
			const raw = typeof query.handle === 'string' ? query.handle.trim().replace(/^@/, '') : ''
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
		.delete('/:siteId/shares/:shareId', async ({ params, auth, set }) => {
			try {
				await revokeSiteShare(params.siteId, auth.did, params.shareId)
				return { success: true }
			} catch (err) {
				logger.error('[PrivateSite] Revoke share error', err)
				return errorResponse(err, set)
			}
		})
		.delete('/:siteId', async ({ params, auth, set }) => {
			try {
				await deleteOwnedPrivateSite(params.siteId, auth.did)
				return { success: true }
			} catch (err) {
				logger.error('[PrivateSite] Delete error', err)
				return errorResponse(err, set)
			}
		})
