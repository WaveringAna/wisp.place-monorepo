import { compressFile, shouldCompressFile } from '@wispplace/atproto-utils'
import type { UploadedFile } from '@wispplace/fs-utils'
import {
	buildStandardDocumentUri,
	type DetectedStandardSitePost,
	injectStandardSiteDocumentLink,
	normalizeSitePath,
	type StaticSiteFile,
	stripUploadRoot,
} from '@wispplace/standard-site'

function isHtmlPath(path: string): boolean {
	return /\.html?$/i.test(path)
}

function htmlCandidatesForPost(post: DetectedStandardSitePost): string[] {
	const candidates: string[] = []
	const filePath = normalizeSitePath(post.filePath)

	if (isHtmlPath(filePath)) {
		candidates.push(filePath)
	}

	const routePath = post.path.replace(/^\/+/, '').replace(/\/+$/, '')
	if (routePath.length === 0) {
		candidates.push('index.html')
	} else {
		candidates.push(`${routePath}/index.html`, `${routePath}.html`)
	}

	return [...new Set(candidates.map(normalizeSitePath))]
}

function decodeStaticSiteFileContent(content: StaticSiteFile['content']): string | undefined {
	if (typeof content === 'string') return content
	if (content instanceof ArrayBuffer) return new TextDecoder().decode(content)
	if (ArrayBuffer.isView(content)) return new TextDecoder().decode(content)
	return undefined
}

function hasSharedPathRoot(paths: string[]): boolean {
	const pathsWithSegments = paths.filter((path) => path.includes('/'))
	if (pathsWithSegments.length === 0 || pathsWithSegments.length !== paths.length) return false

	const firstSegment = pathsWithSegments[0]?.split('/')[0]
	if (!firstSegment) return false

	return pathsWithSegments.every((path) => path.split('/')[0] === firstSegment)
}

function normalizeUploadLookupPath(path: string, shouldStripRoot: boolean): string {
	return shouldStripRoot ? stripUploadRoot(path) : normalizeSitePath(path)
}

export function injectStandardSiteLinksIntoUploadBuffers(options: {
	did: string
	posts: DetectedStandardSitePost[]
	uploadedFiles: UploadedFile[]
	standardSiteFiles: StaticSiteFile[]
}): number {
	const uploadedFileIndexes = new Map<string, number>()
	const standardSiteFileIndexes = new Map<string, number>()
	const shouldStripRoot = hasSharedPathRoot(options.uploadedFiles.map((file) => normalizeSitePath(file.name)))

	options.uploadedFiles.forEach((file, index) => {
		uploadedFileIndexes.set(normalizeUploadLookupPath(file.name, shouldStripRoot), index)
	})
	options.standardSiteFiles.forEach((file, index) => {
		standardSiteFileIndexes.set(normalizeUploadLookupPath(file.path, shouldStripRoot), index)
	})

	let injected = 0
	const touchedFiles = new Set<string>()

	for (const post of options.posts) {
		const htmlPath = htmlCandidatesForPost(post).find((candidate) => uploadedFileIndexes.has(candidate))
		if (!htmlPath || touchedFiles.has(htmlPath)) continue

		const uploadIndex = uploadedFileIndexes.get(htmlPath)
		const staticIndex = standardSiteFileIndexes.get(htmlPath)
		if (uploadIndex === undefined || staticIndex === undefined) continue

		const uploadFile = options.uploadedFiles[uploadIndex]
		const staticFile = options.standardSiteFiles[staticIndex]
		if (!uploadFile || !staticFile || !isHtmlPath(normalizeUploadLookupPath(uploadFile.name, shouldStripRoot))) continue

		const html = decodeStaticSiteFileContent(staticFile.content)
		if (!html) continue

		const documentUri = buildStandardDocumentUri(options.did, post.path)
		const result = injectStandardSiteDocumentLink(html, documentUri)
		if (!result.changed) continue

		const rewrittenContent = Buffer.from(result.html)
		const originalMimeType = uploadFile.originalMimeType || uploadFile.mimeType
		const normalizedPath = stripUploadRoot(uploadFile.name)
		const shouldCompress = shouldCompressFile(originalMimeType, normalizedPath)
		const finalContent = shouldCompress ? compressFile(rewrittenContent) : rewrittenContent

		options.uploadedFiles[uploadIndex] = {
			...uploadFile,
			content: finalContent,
			size: finalContent.length,
			compressed: shouldCompress,
			originalMimeType,
		}
		options.standardSiteFiles[staticIndex] = {
			...staticFile,
			content: rewrittenContent,
			size: rewrittenContent.length,
		}
		touchedFiles.add(htmlPath)
		injected++
	}

	return injected
}
