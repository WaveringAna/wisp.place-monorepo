import {
	type DetectedStandardSitePost,
	type PublishStandardSiteOptions,
	type PublishStandardSiteResult,
	type RepoAgent,
	STANDARD_SITE_DOCUMENT_COLLECTION,
	STANDARD_SITE_PUBLICATION_COLLECTION,
	type StandardSiteDocumentRecord,
	type StandardSitePublicationRecord,
	type StrongRef,
} from './types'

export { buildStandardPublicationUri, buildWispSiteUrl } from './detection'

export function documentRkeyForPath(path: string): string {
	return `p${hashString(path).slice(0, 31)}`
}

export async function publishStandardSite(options: PublishStandardSiteOptions): Promise<PublishStandardSiteResult> {
	const publication = await putStandardSitePublication(options)
	const documents = await syncStandardSiteDocuments({
		agent: options.agent,
		did: options.did,
		publicationUri: publication.uri,
		posts: options.detection.posts,
		deleteStaleDocuments: options.deleteStaleDocuments ?? true,
	})

	return {
		publication,
		documents,
	}
}

async function putStandardSitePublication(options: PublishStandardSiteOptions): Promise<StrongRef> {
	const publicationUri = `at://${options.did}/${STANDARD_SITE_PUBLICATION_COLLECTION}/${options.siteRkey}`
	const existing = await getRecordValue<StandardSitePublicationRecord>(
		options.agent,
		options.did,
		STANDARD_SITE_PUBLICATION_COLLECTION,
		options.siteRkey,
	)
	const createdAt = existing?.createdAt ?? (options.now ?? new Date()).toISOString()
	const record: StandardSitePublicationRecord = {
		$type: STANDARD_SITE_PUBLICATION_COLLECTION,
		url: options.detection.publication.url,
		name: options.detection.publication.name,
		createdAt,
		...(options.detection.publication.description && { description: options.detection.publication.description }),
		...(options.detection.publication.icon && { icon: options.detection.publication.icon }),
		...(options.showInDiscover !== undefined && { preferences: { showInDiscover: options.showInDiscover } }),
	}

	const response = await options.agent.com.atproto.repo.putRecord({
		repo: options.did,
		collection: STANDARD_SITE_PUBLICATION_COLLECTION,
		rkey: options.siteRkey,
		record: record as unknown as Record<string, unknown>,
	})

	return {
		uri: response.data.uri || publicationUri,
		cid: response.data.cid,
	}
}

async function syncStandardSiteDocuments(options: {
	agent: RepoAgent
	did: string
	publicationUri: string
	posts: DetectedStandardSitePost[]
	deleteStaleDocuments: boolean
}): Promise<PublishStandardSiteResult['documents']> {
	const existing = options.deleteStaleDocuments
		? await listDocumentsForPublication(options.agent, options.did, options.publicationUri)
		: []
	const desiredPaths = new Set(options.posts.map((post) => post.path))
	let createdOrUpdated = 0
	let skipped = 0

	for (const post of options.posts) {
		const record = buildDocumentRecord(post, options.publicationUri)
		if (!record) {
			skipped++
			continue
		}

		await options.agent.com.atproto.repo.putRecord({
			repo: options.did,
			collection: STANDARD_SITE_DOCUMENT_COLLECTION,
			rkey: documentRkeyForPath(post.path),
			record: record as unknown as Record<string, unknown>,
		})
		createdOrUpdated++
	}

	let deleted = 0
	for (const record of existing) {
		if (desiredPaths.has(record.value.path)) continue

		const rkey = parseAtUri(record.uri)?.rkey
		if (!rkey) continue

		await options.agent.com.atproto.repo.deleteRecord({
			repo: options.did,
			collection: STANDARD_SITE_DOCUMENT_COLLECTION,
			rkey,
		})
		deleted++
	}

	return { createdOrUpdated, deleted, skipped }
}

function buildDocumentRecord(
	post: DetectedStandardSitePost,
	publicationUri: string,
): StandardSiteDocumentRecord | undefined {
	const publishedAt = coerceIsoDate(post.publishedAt)
	if (!publishedAt) return undefined

	const updatedAt = post.updatedAt ? coerceIsoDate(post.updatedAt) : undefined

	return {
		$type: STANDARD_SITE_DOCUMENT_COLLECTION,
		title: post.title,
		site: publicationUri,
		path: post.path,
		publishedAt,
		...(updatedAt && { updatedAt }),
		...(post.canonicalUrl && { canonicalUrl: post.canonicalUrl }),
		...(post.description && { description: post.description }),
		...(post.textContent && { textContent: post.textContent }),
		...(post.tags && post.tags.length > 0 && { tags: post.tags }),
		...(post.coverImage && { coverImage: post.coverImage }),
	}
}

async function getRecordValue<T>(
	agent: RepoAgent,
	did: string,
	collection: string,
	rkey: string,
): Promise<T | undefined> {
	try {
		const response = await agent.com.atproto.repo.getRecord({
			repo: did,
			collection,
			rkey,
		})
		return response.data.value as T
	} catch {
		return undefined
	}
}

async function listDocumentsForPublication(
	agent: RepoAgent,
	did: string,
	publicationUri: string,
): Promise<Array<{ uri: string; value: StandardSiteDocumentRecord }>> {
	const documents: Array<{ uri: string; value: StandardSiteDocumentRecord }> = []
	let cursor: string | undefined

	do {
		const response = await agent.com.atproto.repo.listRecords({
			repo: did,
			collection: STANDARD_SITE_DOCUMENT_COLLECTION,
			limit: 100,
			cursor,
		})

		for (const record of response.data.records) {
			if (isStandardSiteDocument(record.value) && record.value.site === publicationUri) {
				documents.push({
					uri: record.uri,
					value: record.value,
				})
			}
		}

		cursor = response.data.cursor
	} while (cursor)

	return documents
}

function isStandardSiteDocument(value: unknown): value is StandardSiteDocumentRecord {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>

	return (
		record.$type === STANDARD_SITE_DOCUMENT_COLLECTION &&
		typeof record.title === 'string' &&
		typeof record.site === 'string' &&
		typeof record.path === 'string' &&
		typeof record.publishedAt === 'string'
	)
}

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | undefined {
	const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/)
	if (!match) return undefined

	return {
		did: match[1]!,
		collection: match[2]!,
		rkey: match[3]!,
	}
}

function coerceIsoDate(value: string): string | undefined {
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function hashString(value: string): string {
	const digest = new Bun.CryptoHasher('sha256').update(value).digest('hex')
	return digest.toString()
}
