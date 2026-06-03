export const STANDARD_SITE_PUBLICATION_COLLECTION = 'site.standard.publication'
export const STANDARD_SITE_DOCUMENT_COLLECTION = 'site.standard.document'

export type StandardSiteFramework =
	| 'astro'
	| 'hugo'
	| 'eleventy'
	| 'next'
	| 'gatsby'
	| 'sveltekit'
	| 'jekyll'
	| 'zola'
	| 'unknown'

export interface StaticSiteFile {
	path: string
	content: ArrayBuffer | Uint8Array | Buffer | string
	mimeType?: string
	size?: number
}

export interface BlobObject {
	$type: 'blob'
	ref: unknown
	mimeType: string
	size: number
}

export interface UploadedBlobReference {
	path: string
	blob: unknown
	mimeType?: string
	size?: number
}

export interface StandardSitePublication {
	url: string
	name: string
	description?: string
	icon?: BlobObject
}

export interface DetectedStandardSitePost {
	path: string
	filePath: string
	title: string
	publishedAt: string
	updatedAt?: string
	canonicalUrl?: string
	description?: string
	tags?: string[]
	textContent?: string
	coverImagePath?: string
	coverImage?: BlobObject
}

export interface StandardSiteDetectionResult {
	detected: boolean
	score: number
	framework: StandardSiteFramework
	reasons: string[]
	publication: StandardSitePublication
	posts: DetectedStandardSitePost[]
}

export interface StandardSiteDetectionOptions {
	siteUrl: string
	siteName: string
	files: StaticSiteFile[]
	blobReferences?: UploadedBlobReference[]
	now?: Date
}

export interface StandardSitePublicationRecord {
	$type: 'site.standard.publication'
	url: string
	name: string
	description?: string
	icon?: BlobObject
	createdAt: string
	preferences?: {
		showInDiscover?: boolean
	}
}

export interface StandardSiteDocumentRecord {
	$type: 'site.standard.document'
	title: string
	site: string
	path: string
	textContent?: string
	publishedAt: string
	updatedAt?: string
	canonicalUrl?: string
	description?: string
	coverImage?: BlobObject
	tags?: string[]
}

export interface StrongRef {
	uri: string
	cid: string
}

export interface RepoRecord {
	uri: string
	cid: string
	value: unknown
}

export interface RepoAgent {
	did?: string
	com: {
		atproto: {
			repo: {
				getRecord(input: { repo: string; collection: string; rkey: string }): Promise<{
					data: { uri?: string; cid?: string; value?: unknown }
				}>
				putRecord(input: {
					repo: string
					collection: string
					rkey: string
					record: Record<string, unknown>
				}): Promise<{ data: { uri: string; cid: string } }>
				listRecords(input: {
					repo: string
					collection: string
					limit?: number
					cursor?: string
				}): Promise<{ data: { cursor?: string; records: RepoRecord[] } }>
				deleteRecord(input: { repo: string; collection: string; rkey: string }): Promise<unknown>
			}
		}
	}
}

export interface PublishStandardSiteOptions {
	agent: RepoAgent
	did: string
	siteRkey: string
	detection: StandardSiteDetectionResult
	showInDiscover?: boolean
	deleteStaleDocuments?: boolean
	now?: Date
}

export interface PublishStandardSiteResult {
	publication: StrongRef
	documents: {
		createdOrUpdated: number
		deleted: number
		skipped: number
	}
}
