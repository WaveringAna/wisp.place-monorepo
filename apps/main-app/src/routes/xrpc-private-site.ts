import { json, XRPCError, type XRPCRouter } from '@atcute/xrpc-server'
import {
	PlaceWispV2PrivateSiteCreate,
	PlaceWispV2PrivateSiteCreateShare,
	PlaceWispV2PrivateSiteDelete,
	PlaceWispV2PrivateSiteList,
	PlaceWispV2PrivateSiteListShares,
	PlaceWispV2PrivateSiteRevokeShare,
} from '@wispplace/lexicons/atcute'
import { InvalidExpiryError, isExpired } from '@wispplace/private-sites'
import { privateShareUrl, privateSiteUrl, shortShareUrl } from '../lib/private-site-origin'
import { PrivateSiteUploadError, readPrivateSiteUpload } from '../lib/private-site-upload'
import { listShares } from '../lib/private-sites-db'
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

const toXrpcError = (err: unknown): never => {
	if (err instanceof PrivateSiteError) {
		if (err.code === 'notFound') {
			throw new XRPCError({ status: 404, error: 'NotFound', description: err.message })
		}
		if (err.code === 'tooLarge') {
			throw new XRPCError({ status: 413, error: 'PayloadTooLarge', description: err.message })
		}
		throw new XRPCError({ status: 400, error: 'InvalidRequest', description: err.message })
	}
	if (err instanceof InvalidExpiryError) {
		throw new XRPCError({ status: 400, error: 'InvalidRequest', description: err.message })
	}
	if (err instanceof PrivateSiteUploadError) {
		throw new XRPCError({
			status: err.status,
			error: err.status === 413 ? 'PayloadTooLarge' : 'InvalidRequest',
			description: err.message,
		})
	}
	throw err
}

const shareStatus = (share: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): string => {
	if (share.revokedAt !== null) return 'revoked'
	if (isExpired(share.expiresAt, now)) return 'expired'
	return 'active'
}

export interface PrivateSiteXrpcDeps {
	router: XRPCRouter
	requireDid: (request: Request) => string
}

export const registerPrivateSiteMethods = ({ router, requireDid }: PrivateSiteXrpcDeps): void => {
	router.addProcedure(
		PlaceWispV2PrivateSiteCreate.mainSchema as any,
		{
			async handler({ request }: any) {
				const did = requireDid(request)
				try {
					const { name, expiryMinutes, files } = await readPrivateSiteUpload(request)
					const site = await ingestPrivateSite({ ownerDid: did, name, expiryMinutes, files })

					return json({
						siteId: site.siteId,
						name: site.name,
						fileCount: site.fileCount,
						totalBytes: site.totalBytes,
						expiresAt: site.expiresAt ? site.expiresAt.toISOString() : undefined,
						createdAt: site.createdAt.toISOString(),
						url: privateSiteUrl(site.siteId),
					})
				} catch (err) {
					return toXrpcError(err)
				}
			},
		} as any,
	)

	router.addQuery(
		PlaceWispV2PrivateSiteList.mainSchema as any,
		{
			async handler({ request }: any) {
				const did = requireDid(request)
				const now = new Date()
				const sites = await listOwnedPrivateSites(did)

				const summaries = await Promise.all(
					sites.map(async (site) => {
						const shares = await listShares(site.siteId)
						return {
							siteId: site.siteId,
							name: site.name,
							fileCount: site.fileCount,
							totalBytes: site.totalBytes,
							expiresAt: site.expiresAt ? site.expiresAt.toISOString() : undefined,
							createdAt: site.createdAt.toISOString(),
							shareCount: shares.filter((s) => shareStatus(s, now) === 'active').length,
							expired: isExpired(site.expiresAt, now),
						}
					}),
				)

				return json({ sites: summaries })
			},
		} as any,
	)

	router.addProcedure(
		PlaceWispV2PrivateSiteDelete.mainSchema as any,
		{
			async handler({ input, request }: any) {
				const did = requireDid(request)
				try {
					await deleteOwnedPrivateSite(String(input.siteId), did)
					return json({ siteId: input.siteId, deleted: true })
				} catch (err) {
					return toXrpcError(err)
				}
			},
		} as any,
	)

	router.addProcedure(
		PlaceWispV2PrivateSiteCreateShare.mainSchema as any,
		{
			async handler({ input, request }: any) {
				const did = requireDid(request)
				try {
					const { share, token } = await createSiteShare({
						siteId: String(input.siteId),
						ownerDid: did,
						label: input.label ?? null,
						expiryMinutes: input.expiryMinutes,
						audienceDid: input.audienceDid ?? null,
					})
					return json({
						shareId: share.shareId,
						siteId: share.siteId,
						url: shortShareUrl(token),
						directUrl: privateShareUrl(share.siteId, token),
						expiresAt: share.expiresAt ? share.expiresAt.toISOString() : undefined,
						createdAt: share.createdAt.toISOString(),
					})
				} catch (err) {
					return toXrpcError(err)
				}
			},
		} as any,
	)

	router.addQuery(
		PlaceWispV2PrivateSiteListShares.mainSchema as any,
		{
			async handler({ params, request }: any) {
				const did = requireDid(request)
				try {
					const siteId = String(params.siteId)
					await requireOwnedSite(siteId, did)
					const now = new Date()
					const shares = await listSiteShares(siteId, did)

					return json({
						shares: shares.map((share) => ({
							shareId: share.shareId,
							tokenPrefix: share.tokenPrefix,
							label: share.label ?? undefined,
							expiresAt: share.expiresAt ? share.expiresAt.toISOString() : undefined,
							revokedAt: share.revokedAt ? share.revokedAt.toISOString() : undefined,
							createdAt: share.createdAt.toISOString(),
							lastUsedAt: share.lastUsedAt ? share.lastUsedAt.toISOString() : undefined,
							status: shareStatus(share, now),
						})),
					})
				} catch (err) {
					return toXrpcError(err)
				}
			},
		} as any,
	)

	router.addProcedure(
		PlaceWispV2PrivateSiteRevokeShare.mainSchema as any,
		{
			async handler({ input, request }: any) {
				const did = requireDid(request)
				try {
					await revokeSiteShare(String(input.siteId), did, String(input.shareId))
					return json({ shareId: input.shareId, revoked: true })
				} catch (err) {
					return toXrpcError(err)
				}
			},
		} as any,
	)
}
