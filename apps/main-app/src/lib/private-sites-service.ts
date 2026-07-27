import { createHash } from 'node:crypto'
import {
	DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES,
	MAX_PRIVATE_SITE_FILE_COUNT,
	MAX_PRIVATE_SITE_SIZE,
} from '@wispplace/constants'
import { sanitizePath } from '@wispplace/fs-utils'
import { createLogger } from '@wispplace/observability'
import {
	evaluateAccess,
	hashShareTokenSync,
	isValidSiteId,
	type PrivateSite,
	privateGrantUrlFor,
	privateShareLinkUrl,
	resolveExpiry,
	SHARE_TOKEN_PREFIX,
} from '@wispplace/private-sites'
import { privateSiteUrl } from './private-site-origin'
import { deletePrivateSiteFiles, writePrivateFile } from './private-site-storage'
import {
	createOwnerHandoff,
	createPrivateSite,
	createShare,
	createShareHandoff,
	deletePrivateSite,
	findLiveShareForAudience,
	findSharesByTokenHash,
	findSiteIdByShareTokenHash,
	getPrivateSite,
	listPrivateSitesByOwner,
	listShares,
	revokeShare,
	touchShare,
} from './private-sites-db'

const logger = createLogger('main-app')

export class PrivateSiteError extends Error {
	constructor(
		message: string,
		readonly code: 'invalidRequest' | 'notFound' | 'tooLarge',
	) {
		super(message)
		this.name = 'PrivateSiteError'
	}
}

export interface UploadedPrivateFile {
	path: string
	bytes: Uint8Array
	mimeType: string | null
}

export interface CreatePrivateSiteOptions {
	ownerDid: string
	name: string
	expiryMinutes?: number | null
	files: UploadedPrivateFile[]
}

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

export const guessMimeType = (path: string): string => {
	const ext = path.split('.').pop()?.toLowerCase() ?? ''
	return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}
export const ingestPrivateSite = async (options: CreatePrivateSiteOptions): Promise<PrivateSite> => {
	const name = options.name.trim()
	if (name.length === 0) {
		throw new PrivateSiteError('name is required', 'invalidRequest')
	}
	if (name.length > 128) {
		throw new PrivateSiteError('name must be at most 128 characters', 'invalidRequest')
	}
	if (options.files.length === 0) {
		throw new PrivateSiteError('at least one file is required', 'invalidRequest')
	}
	if (options.files.length > MAX_PRIVATE_SITE_FILE_COUNT) {
		throw new PrivateSiteError(`at most ${MAX_PRIVATE_SITE_FILE_COUNT} files are allowed`, 'tooLarge')
	}

	const seen = new Set<string>()
	const prepared = options.files.map((file) => {
		const path = sanitizePath(file.path)
		if (path.length === 0) {
			throw new PrivateSiteError(`invalid file path: ${file.path}`, 'invalidRequest')
		}
		if (/[\\\p{Cc}]/u.test(path)) {
			throw new PrivateSiteError(`invalid file path: ${file.path}`, 'invalidRequest')
		}
		if (seen.has(path)) {
			throw new PrivateSiteError(`duplicate file path: ${path}`, 'invalidRequest')
		}
		seen.add(path)
		return {
			path,
			bytes: file.bytes,
			mimeType: file.mimeType ?? guessMimeType(path),
			sha256: createHash('sha256').update(file.bytes).digest('hex'),
		}
	})

	const totalBytes = prepared.reduce((sum, f) => sum + f.bytes.byteLength, 0)
	if (totalBytes > MAX_PRIVATE_SITE_SIZE) {
		throw new PrivateSiteError(`private sites are limited to ${MAX_PRIVATE_SITE_SIZE} bytes`, 'tooLarge')
	}

	const { expiresAt, usedDefault, neverExpires } = resolveExpiry({
		expiryMinutes: options.expiryMinutes,
		now: new Date(),
	})

	const site = await createPrivateSite({
		ownerDid: options.ownerDid,
		name,
		expiresAt,
		files: prepared.map((f) => ({
			path: f.path,
			size: f.bytes.byteLength,
			mimeType: f.mimeType,
			sha256: f.sha256,
		})),
	})
	try {
		for (const file of prepared) {
			await writePrivateFile(site.siteId, file.path, file.bytes, file.mimeType)
		}
	} catch (err) {
		await deletePrivateSiteFiles(site.siteId).catch(() => 0)
		await deletePrivateSite(site.siteId).catch(() => false)
		throw err
	}

	logger.info('[PrivateSite] Created', {
		siteId: site.siteId,
		fileCount: prepared.length,
		totalBytes,
		neverExpires,
		usedDefaultExpiry: usedDefault,
		defaultExpiryMinutes: usedDefault ? DEFAULT_PRIVATE_SITE_EXPIRY_MINUTES : undefined,
	})

	return site
}

export const requireOwnedSite = async (siteId: string, ownerDid: string): Promise<PrivateSite> => {
	if (!isValidSiteId(siteId)) {
		throw new PrivateSiteError('private site not found', 'notFound')
	}
	const site = await getPrivateSite(siteId)
	if (!site || site.ownerDid !== ownerDid) {
		throw new PrivateSiteError('private site not found', 'notFound')
	}
	return site
}

export const listOwnedPrivateSites = (ownerDid: string) => listPrivateSitesByOwner(ownerDid)

export const deleteOwnedPrivateSite = async (siteId: string, ownerDid: string): Promise<void> => {
	await requireOwnedSite(siteId, ownerDid)
	const removed = await deletePrivateSiteFiles(siteId)
	await deletePrivateSite(siteId)
	logger.info('[PrivateSite] Deleted', { siteId, filesRemoved: removed })
}

export interface CreateShareOptions {
	siteId: string
	ownerDid: string
	label?: string | null
	expiryMinutes?: number | null
	audienceDid?: string | null
}
export const createSiteShare = async (options: CreateShareOptions) => {
	const site = await requireOwnedSite(options.siteId, options.ownerDid)
	const { expiresAt } = resolveExpiry({
		expiryMinutes: options.expiryMinutes,
		now: new Date(),
		clampTo: site.expiresAt,
	})

	const result = await createShare(site.siteId, {
		label: options.label ?? null,
		expiresAt,
		audienceDid: options.audienceDid ?? null,
	})
	logger.info('[PrivateSite] Share created', { siteId: site.siteId, shareId: result.share.shareId })

	return result
}
export const resolveShareLink = async (token: string): Promise<string | null> => {
	if (!token.startsWith(SHARE_TOKEN_PREFIX) || token.length > 128) return null

	const siteId = await findSiteIdByShareTokenHash(hashShareTokenSync(token))
	if (!siteId) return null

	return privateShareLinkUrl(privateSiteUrl(siteId), token)
}
export const redeemScopedShare = async (siteId: string, token: string, viewerDid: string): Promise<string | null> => {
	if (!isValidSiteId(siteId)) return null
	const site = await getPrivateSite(siteId)
	const shares = site ? await findSharesByTokenHash(siteId, hashShareTokenSync(token)) : []
	const decision = evaluateAccess({
		site,
		shares,
		principal: { kind: 'shareToken', token, viewerDid },
		now: new Date(),
	})

	if (!site || !decision.allowed || decision.reason !== 'share') {
		logger.info('[PrivateSite] Scoped redeem denied', { siteId, reason: decision.reason })
		return null
	}

	void touchShare(decision.shareId)
	const handoff = await createShareHandoff(site.siteId, decision.shareId)
	logger.info('[PrivateSite] Scoped share redeemed', { siteId: site.siteId, shareId: decision.shareId })
	return privateGrantUrlFor(privateSiteUrl(site.siteId), handoff)
}
export const openPrivateSiteForAccount = async (siteId: string, viewerDid: string): Promise<string | null> => {
	if (!isValidSiteId(siteId)) return null
	const site = await getPrivateSite(siteId)
	if (!site) return null

	if (site.ownerDid === viewerDid) {
		const handoff = await createOwnerHandoff(site.siteId, viewerDid)
		return privateGrantUrlFor(privateSiteUrl(site.siteId), handoff)
	}
	if (site.expiresAt !== null && site.expiresAt <= new Date()) return null

	const share = await findLiveShareForAudience(site.siteId, viewerDid)
	if (!share) {
		logger.info('[PrivateSite] Account open denied', { siteId })
		return null
	}

	const handoff = await createShareHandoff(site.siteId, share.shareId)
	return privateGrantUrlFor(privateSiteUrl(site.siteId), handoff)
}

export const listSiteShares = async (siteId: string, ownerDid: string) => {
	await requireOwnedSite(siteId, ownerDid)
	return listShares(siteId)
}

export const revokeSiteShare = async (siteId: string, ownerDid: string, shareId: string): Promise<void> => {
	await requireOwnedSite(siteId, ownerDid)
	const revoked = await revokeShare(siteId, shareId)
	if (!revoked) {
		throw new PrivateSiteError('share not found', 'notFound')
	}
	logger.info('[PrivateSite] Share revoked', { siteId, shareId })
}
