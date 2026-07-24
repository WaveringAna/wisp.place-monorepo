/**
 * XRPC handlers for private sites.
 *
 * Registered by `routes/xrpc.ts` alongside the other `place.wisp.v2.*` methods, using the
 * same service-auth JWT identity, so the CLI reaches these exactly as it reaches domain and
 * secret methods.
 *
 * Every handler is owner-scoped. Authorization for *reading* a private site is not decided
 * here; that lives in `evaluateAccess` and runs in the hosting service.
 */

import { json, XRPCError, type XRPCRouter } from '@atcute/xrpc-server'
import {
	BASE_HOST,
	MAX_PRIVATE_SITE_FILE_COUNT,
	MAX_PRIVATE_SITE_SIZE,
	PRIVATE_SHARE_QUERY_PARAM,
} from '@wispplace/constants'
import {
	PlaceWispV2PrivateSiteCreate,
	PlaceWispV2PrivateSiteCreateShare,
	PlaceWispV2PrivateSiteDelete,
	PlaceWispV2PrivateSiteList,
	PlaceWispV2PrivateSiteListShares,
	PlaceWispV2PrivateSiteRevokeShare,
} from '@wispplace/lexicons/atcute'
import { InvalidExpiryError, isExpired } from '@wispplace/private-sites'
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
	type UploadedPrivateFile,
} from '../lib/private-sites-service'

/** Base URL of the dedicated private-site host. */
export const privateHostBase = (): string => {
	const explicit = process.env.PRIVATE_SITE_BASE_URL
	if (explicit) return explicit.replace(/\/+$/, '')
	const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http'
	return `${scheme}://priv.${BASE_HOST}`
}

export const privateSiteUrl = (siteId: string): string => `${privateHostBase()}/${siteId}/`

/** Share URL. Contains the credential, so it is returned once and never logged. */
export const privateShareUrl = (siteId: string, token: string): string =>
	`${privateSiteUrl(siteId)}?${PRIVATE_SHARE_QUERY_PARAM}=${encodeURIComponent(token)}`

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
	throw err
}

const parseExpiryMinutes = (raw: unknown): number | null | undefined => {
	if (raw === undefined || raw === null || raw === '') return undefined
	const value = typeof raw === 'number' ? raw : Number(raw)
	if (!Number.isFinite(value)) {
		throw new XRPCError({ status: 400, error: 'InvalidRequest', description: 'expiryMinutes must be a number' })
	}
	return value
}

const shareStatus = (share: { revokedAt: Date | null; expiresAt: Date | null }, now: Date): string => {
	if (share.revokedAt !== null) return 'revoked'
	if (isExpired(share.expiresAt, now)) return 'expired'
	return 'active'
}

/**
 * Read a multipart upload into memory.
 *
 * Enforces the file-count and total-size ceilings while reading so an oversized upload is
 * rejected rather than buffered in full.
 */
const readMultipart = async (
	request: Request,
): Promise<{ name: string; expiryMinutes: number | null | undefined; files: UploadedPrivateFile[] }> => {
	let form: FormData
	try {
		form = await request.formData()
	} catch {
		throw new XRPCError({ status: 400, error: 'InvalidRequest', description: 'expected multipart/form-data body' })
	}

	const name = String(form.get('name') ?? '').trim()
	const expiryMinutes = parseExpiryMinutes(form.get('expiryMinutes'))

	const files: UploadedPrivateFile[] = []
	let total = 0

	for (const [field, value] of form.entries()) {
		if (field !== 'files' && field !== 'file') continue
		if (typeof value === 'string') continue
		const file = value as File

		if (files.length >= MAX_PRIVATE_SITE_FILE_COUNT) {
			throw new XRPCError({
				status: 413,
				error: 'PayloadTooLarge',
				description: `at most ${MAX_PRIVATE_SITE_FILE_COUNT} files are allowed`,
			})
		}

		total += file.size
		if (total > MAX_PRIVATE_SITE_SIZE) {
			throw new XRPCError({
				status: 413,
				error: 'PayloadTooLarge',
				description: `private sites are limited to ${MAX_PRIVATE_SITE_SIZE} bytes`,
			})
		}

		files.push({
			// `webkitRelativePath` preserves directory structure when a folder is uploaded.
			path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
			bytes: new Uint8Array(await file.arrayBuffer()),
			mimeType: file.type || null,
		})
	}

	return { name, expiryMinutes, files }
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
					const { name, expiryMinutes, files } = await readMultipart(request)
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
					})

					// The URL embeds the credential. It is returned exactly once and is never
					// persisted or logged in this form.
					return json({
						shareId: share.shareId,
						siteId: share.siteId,
						url: privateShareUrl(share.siteId, token),
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
							// Never the token itself.
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
