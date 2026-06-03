import type {
	BlobObject,
	DetectedStandardSitePost,
	StandardSiteDetectionOptions,
	StandardSiteDetectionResult,
	StandardSiteFramework,
	StaticSiteFile,
	UploadedBlobReference,
} from './types'

const HTML_EXTENSIONS = new Set(['.html', '.htm'])
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx'])
const MAX_TEXT_CONTENT_LENGTH = 20000

const DATE_FIELDS = ['publishDate', 'pubDate', 'date', 'createdAt', 'created_at', 'publishedAt', 'published_at']
const UPDATED_FIELDS = ['updatedAt', 'updated_at', 'modifiedAt', 'modified_at']

interface NormalizedFile extends StaticSiteFile {
	path: string
	normalizedPath: string
	text?: string
}

interface ExtractedPage {
	title?: string
	description?: string
	publishedAt?: string
	updatedAt?: string
	tags: string[]
	canonicalUrl?: string
	coverImagePath?: string
	textContent?: string
	articleIndicators: number
	draft?: boolean
}

export function normalizeSitePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

export function stripUploadRoot(path: string): string {
	return normalizeSitePath(path).replace(/^[^/]*\//, '')
}

export function buildStandardPublicationUri(did: string, siteRkey: string): string {
	return `at://${did}/site.standard.publication/${siteRkey}`
}

export function buildWispSiteUrl(did: string, siteRkey: string): string {
	return `https://sites.wisp.place/${did}/${siteRkey}`
}

export function buildPublicationWellKnownFile(did: string, siteRkey: string): StaticSiteFile {
	const publicationUri = buildStandardPublicationUri(did, siteRkey)

	return {
		path: '.well-known/site.standard.publication',
		content: publicationUri,
		mimeType: 'text/plain;charset=utf-8',
		size: publicationUri.length,
	}
}

export function detectStandardSite(options: StandardSiteDetectionOptions): StandardSiteDetectionResult {
	const siteUrl = stripTrailingSlash(options.siteUrl)
	const normalizedFiles = normalizeFiles(options.files)
	const blobMap = buildBlobMap(options.blobReferences ?? [])
	const rootHtml = findFile(normalizedFiles, 'index.html')
	const rootText = rootHtml ? decodeText(rootHtml.content) : undefined
	const framework = detectFramework(normalizedFiles, rootText)
	const rootMeta = rootText ? extractHtmlPage(rootText, '/', siteUrl) : undefined
	const posts = normalizedFiles
		.flatMap((file) => detectPost(file, siteUrl, blobMap))
		.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())

	const reasons = buildReasons(posts, framework, normalizedFiles)
	const score = Math.min(100, posts.length * 18 + (framework === 'unknown' ? 0 : 12) + reasons.length * 4)
	const publicationName = rootMeta?.title ? cleanSiteTitle(rootMeta.title) : titleizeSiteName(options.siteName)

	return {
		detected: posts.length > 0,
		score,
		framework,
		reasons,
		publication: {
			url: siteUrl,
			name: publicationName || titleizeSiteName(options.siteName),
			...(rootMeta?.description && { description: rootMeta.description }),
		},
		posts,
	}
}

function normalizeFiles(files: StaticSiteFile[]): NormalizedFile[] {
	const rawPaths = files.map((file) => normalizeSitePath(file.path)).filter(Boolean)
	const shouldStripRoot = hasSharedUploadRoot(rawPaths)

	return files.map((file) => {
		const normalizedPath = shouldStripRoot ? stripUploadRoot(file.path) : normalizeSitePath(file.path)
		return {
			...file,
			path: normalizedPath,
			normalizedPath,
		}
	})
}

function hasSharedUploadRoot(paths: string[]): boolean {
	const pathsWithSegments = paths.filter((path) => path.includes('/'))
	if (pathsWithSegments.length === 0) return false
	if (paths.some((path) => !path.includes('/'))) return false

	const firstSegment = pathsWithSegments[0]?.split('/')[0]
	if (!firstSegment) return false

	return pathsWithSegments.every((path) => path.split('/')[0] === firstSegment)
}

function findFile(files: NormalizedFile[], filePath: string): NormalizedFile | undefined {
	return files.find((file) => file.normalizedPath === filePath)
}

function detectPost(
	file: NormalizedFile,
	siteUrl: string,
	blobMap: Map<string, BlobObject>,
): DetectedStandardSitePost[] {
	const extension = getExtension(file.normalizedPath)

	if (HTML_EXTENSIONS.has(extension)) {
		return detectHtmlPost(file, siteUrl, blobMap)
	}

	if (MARKDOWN_EXTENSIONS.has(extension)) {
		return detectMarkdownPost(file, siteUrl, blobMap)
	}

	return []
}

function detectHtmlPost(
	file: NormalizedFile,
	siteUrl: string,
	blobMap: Map<string, BlobObject>,
): DetectedStandardSitePost[] {
	if (isNonPostPath(file.normalizedPath)) return []

	const html = decodeText(file.content)
	if (!html) return []

	const routePath = htmlPathToRoutePath(file.normalizedPath)
	if (routePath === '/' || isNonPostRoute(routePath)) return []

	const page = extractHtmlPage(html, routePath, siteUrl)
	if (!page.title || page.draft) return []

	const publishedAt = coerceDate(page.publishedAt) ?? coerceDate(extractDateFromPath(routePath))
	if (!publishedAt) return []

	const articleConfidence = page.articleIndicators + (routePathLooksLikePost(routePath) ? 1 : 0)
	if (articleConfidence < 1) return []

	const coverImagePath = page.coverImagePath ? resolveAssetPath(page.coverImagePath, routePath, siteUrl) : undefined
	const coverImage = coverImagePath ? blobMap.get(coverImagePath) : undefined
	const canonicalUrl = page.canonicalUrl ?? `${siteUrl}${routePath === '/' ? '' : routePath}`

	return [
		{
			filePath: file.normalizedPath,
			path: routePath,
			title: page.title,
			publishedAt,
			...(page.updatedAt && { updatedAt: coerceDate(page.updatedAt) ?? undefined }),
			...(page.description && { description: page.description }),
			...(canonicalUrl && { canonicalUrl }),
			...(page.tags.length > 0 && { tags: page.tags }),
			...(page.textContent && { textContent: page.textContent }),
			...(coverImagePath && { coverImagePath }),
			...(coverImage && { coverImage }),
		},
	]
}

function detectMarkdownPost(
	file: NormalizedFile,
	siteUrl: string,
	blobMap: Map<string, BlobObject>,
): DetectedStandardSitePost[] {
	const content = decodeText(file.content)
	if (!content) return []

	const parsed = parseFrontmatter(content)
	if (!parsed || parsed.frontmatter.draft === true || parsed.frontmatter.draft === 'true') return []

	const title = asString(parsed.frontmatter.title)
	if (!title) return []

	const publishedAt = firstDate(parsed.frontmatter, DATE_FIELDS)
	if (!publishedAt) return []

	const routePath = markdownPathToRoutePath(file.normalizedPath)
	if (isNonPostRoute(routePath)) return []

	const coverImagePath = asString(parsed.frontmatter.ogImage ?? parsed.frontmatter.coverImage)
	const resolvedCoverImagePath = coverImagePath ? resolveAssetPath(coverImagePath, routePath, siteUrl) : undefined
	const coverImage = resolvedCoverImagePath ? blobMap.get(resolvedCoverImagePath) : undefined
	const tags = normalizeTags(parsed.frontmatter.tags ?? parsed.frontmatter.categories ?? parsed.frontmatter.keywords)
	const updatedAt = firstDate(parsed.frontmatter, UPDATED_FIELDS)
	const textContent = stripMarkdownForText(parsed.body)

	return [
		{
			filePath: file.normalizedPath,
			path: routePath,
			title,
			publishedAt,
			canonicalUrl: `${siteUrl}${routePath === '/' ? '' : routePath}`,
			...(updatedAt && { updatedAt }),
			...(asString(parsed.frontmatter.description) && { description: asString(parsed.frontmatter.description) }),
			...(tags.length > 0 && { tags }),
			...(textContent && { textContent }),
			...(resolvedCoverImagePath && { coverImagePath: resolvedCoverImagePath }),
			...(coverImage && { coverImage }),
		},
	]
}

function extractHtmlPage(html: string, routePath: string, siteUrl: string): ExtractedPage {
	const jsonLdObjects = extractJsonLdObjects(html)
	const articleJsonLd = jsonLdObjects.find((value) => hasJsonLdType(value, ['BlogPosting', 'Article', 'NewsArticle']))
	const title =
		metaContent(html, ['property'], ['og:title']) ??
		metaContent(html, ['name'], ['twitter:title']) ??
		asString(articleJsonLd?.headline) ??
		textContentOfFirstTag(html, 'h1') ??
		textContentOfFirstTag(html, 'title')
	const description =
		metaContent(html, ['name'], ['description']) ??
		metaContent(html, ['property'], ['og:description']) ??
		metaContent(html, ['name'], ['twitter:description']) ??
		asString(articleJsonLd?.description)
	const canonical = linkHref(html, 'canonical')
	const canonicalUrl = canonical ? absolutizeUrl(canonical, routePath, siteUrl) : undefined
	const publishedAt =
		metaContent(html, ['property'], ['article:published_time']) ??
		metaContent(html, ['name', 'itemprop'], ['datePublished', 'pubdate', 'publishDate']) ??
		asString(articleJsonLd?.datePublished) ??
		timeDatetime(html)
	const updatedAt =
		metaContent(html, ['property'], ['article:modified_time']) ??
		metaContent(html, ['name', 'itemprop'], ['dateModified', 'updatedAt']) ??
		asString(articleJsonLd?.dateModified)
	const coverImage =
		metaContent(html, ['property'], ['og:image']) ??
		metaContent(html, ['name'], ['twitter:image']) ??
		jsonLdImage(articleJsonLd)
	const tags = uniqueStrings([
		...normalizeTags(metaContent(html, ['name'], ['keywords'])),
		...metaContents(html, ['property'], ['article:tag']),
		...normalizeTags(articleJsonLd?.keywords),
	])
	const ogType = metaContent(html, ['property'], ['og:type'])
	const textContent = extractArticleText(html)
	const articleIndicators = [
		/<article[\s>]/i.test(html),
		ogType === 'article',
		!!articleJsonLd,
		!!publishedAt,
		routePathLooksLikePost(routePath),
	].filter(Boolean).length

	return {
		title: cleanTitle(title),
		description: cleanDescription(description),
		publishedAt,
		updatedAt,
		canonicalUrl,
		coverImagePath: coverImage,
		tags,
		textContent,
		articleIndicators,
	}
}

function buildBlobMap(references: UploadedBlobReference[]): Map<string, BlobObject> {
	const map = new Map<string, BlobObject>()

	for (const reference of references) {
		const blob = normalizeBlobObject(reference.blob, reference.mimeType, reference.size)
		if (!blob) continue

		const normalizedPath = stripUploadRoot(reference.path)
		map.set(normalizedPath, blob)
		map.set(normalizeSitePath(reference.path), blob)
	}

	return map
}

export function normalizeBlobObject(
	blob: unknown,
	fallbackMimeType?: string,
	fallbackSize?: number,
): BlobObject | undefined {
	if (!blob || typeof blob !== 'object') return undefined

	const value = blob as Record<string, unknown>
	const ref = value.ref
	const mimeType = asString(value.mimeType) ?? fallbackMimeType
	const size = typeof value.size === 'number' ? value.size : fallbackSize

	if (!ref || !mimeType || typeof size !== 'number') return undefined

	return {
		$type: 'blob',
		ref,
		mimeType,
		size,
	}
}

function detectFramework(files: NormalizedFile[], rootHtml?: string): StandardSiteFramework {
	const paths = new Set(files.map((file) => file.normalizedPath))
	const generator = rootHtml ? metaContent(rootHtml, ['name'], ['generator'])?.toLowerCase() : undefined

	if ([...paths].some((path) => path.startsWith('_astro/')) || generator?.includes('astro')) return 'astro'
	if ([...paths].some((path) => path.startsWith('_next/')) || rootHtml?.includes('/_next/')) return 'next'
	if ([...paths].some((path) => path.startsWith('_app/immutable/')) || rootHtml?.includes('/_app/immutable/'))
		return 'sveltekit'
	if ([...paths].some((path) => path.startsWith('assets/gatsby-')) || rootHtml?.includes('gatsby')) return 'gatsby'
	if (generator?.includes('hugo')) return 'hugo'
	if (generator?.includes('eleventy') || generator?.includes('11ty')) return 'eleventy'
	if (generator?.includes('jekyll') || [...paths].some((path) => path.startsWith('assets/main.css'))) return 'jekyll'
	if (generator?.includes('zola')) return 'zola'

	return 'unknown'
}

function buildReasons(
	posts: DetectedStandardSitePost[],
	framework: StandardSiteFramework,
	files: NormalizedFile[],
): string[] {
	const reasons: string[] = []
	const htmlCount = files.filter((file) => HTML_EXTENSIONS.has(getExtension(file.normalizedPath))).length

	if (framework !== 'unknown') reasons.push(`detected ${framework} build output`)
	if (htmlCount > 1) reasons.push(`found ${htmlCount} html pages`)
	if (posts.length > 0) reasons.push(`found ${posts.length} dated article page${posts.length === 1 ? '' : 's'}`)

	return reasons
}

function parseFrontmatter(content: string):
	| {
			frontmatter: Record<string, unknown>
			body: string
	  }
	| undefined {
	const match = content.match(/^(---|\+\+\+|\*\*\*)\r?\n([\s\S]*?)\r?\n\1\r?\n([\s\S]*)$/)
	if (!match) return undefined

	const delimiter = match[1]
	const frontmatterText = match[2] ?? ''
	const body = match[3] ?? ''

	return {
		frontmatter: delimiter === '+++' ? parseTomlLike(frontmatterText) : parseYamlLike(frontmatterText),
		body,
	}
}

function parseYamlLike(source: string): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	let listKey: string | undefined

	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue

		const listMatch = line.match(/^-\s+(.+)$/)
		if (listMatch && listKey) {
			const existing = Array.isArray(result[listKey]) ? (result[listKey] as unknown[]) : []
			result[listKey] = [...existing, parseScalar(listMatch[1]!)]
			continue
		}

		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
		if (!match) continue

		const key = match[1]!
		const value = match[2] ?? ''
		listKey = value === '' ? key : undefined
		result[key] = value === '' ? [] : parseScalar(value)
	}

	return result
}

function parseTomlLike(source: string): Record<string, unknown> {
	const result: Record<string, unknown> = {}

	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue

		const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/)
		if (!match) continue

		result[match[1]!] = parseScalar(match[2] ?? '')
	}

	return result
}

function parseScalar(value: string): unknown {
	const trimmed = value.trim()
	if (trimmed === 'true') return true
	if (trimmed === 'false') return false
	if (/^["'].*["']$/.test(trimmed)) return trimmed.slice(1, -1)
	if (/^\[.*\]$/.test(trimmed)) {
		const inner = trimmed.slice(1, -1).trim()
		if (!inner) return []
		return inner.split(',').map((part) => String(parseScalar(part.trim())))
	}
	return trimmed
}

function decodeText(content: StaticSiteFile['content']): string | undefined {
	if (typeof content === 'string') return content
	if (content instanceof ArrayBuffer) return new TextDecoder().decode(content)
	if (ArrayBuffer.isView(content)) return new TextDecoder().decode(content)
	return undefined
}

function getExtension(path: string): string {
	const lastSegment = path.split('/').pop() ?? ''
	const dotIndex = lastSegment.lastIndexOf('.')
	return dotIndex === -1 ? '' : lastSegment.slice(dotIndex).toLowerCase()
}

function htmlPathToRoutePath(path: string): string {
	const withoutIndex = path.replace(/(?:^|\/)index\.html?$/i, '')
	if (!withoutIndex) return '/'

	const withoutExtension = withoutIndex.replace(/\.html?$/i, '')
	return `/${withoutExtension}`.replace(/\/+/g, '/')
}

function markdownPathToRoutePath(path: string): string {
	const withoutContentPrefix = path.replace(/^(?:src\/content\/)?(?:blog|posts|articles|content)\//, '')
	const withoutExtension = withoutContentPrefix.replace(/\.mdx?$/i, '')
	const withoutIndex = withoutExtension.replace(/\/(?:_?index)$/, '')
	const withoutDatePrefix = withoutIndex.replace(/(^|\/)\d{4}-\d{2}-\d{2}-/, '$1')
	return `/${withoutDatePrefix}`.replace(/\/+/g, '/')
}

function isNonPostPath(path: string): boolean {
	return /(^|\/)(404|500|sitemap|rss|feed|atom|robots)\.(html?|xml|txt)$/i.test(path)
}

function isNonPostRoute(routePath: string): boolean {
	return /(^|\/)(tags?|categories?|archives?|authors?|search|page)(\/|$)/i.test(routePath)
}

function routePathLooksLikePost(routePath: string): boolean {
	return (
		/(^|\/)(blog|posts?|articles?|writing|notes|journal)(\/|$)/i.test(routePath) ||
		/\d{4}[/-]\d{2}[/-]\d{2}/.test(routePath)
	)
}

function extractDateFromPath(routePath: string): string | undefined {
	return routePath
		.match(/(\d{4})[/-](\d{2})[/-](\d{2})/)
		?.slice(1, 4)
		.join('-')
}

function firstDate(source: Record<string, unknown>, fields: string[]): string | undefined {
	for (const field of fields) {
		const date = coerceDate(source[field])
		if (date) return date
	}
	return undefined
}

function coerceDate(input: unknown): string | undefined {
	const value = Array.isArray(input) ? input[0] : input
	if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return undefined

	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return undefined

	return date.toISOString()
}

function cleanTitle(value: unknown): string | undefined {
	const title = asString(value)?.replace(/\s+/g, ' ').trim()
	if (!title) return undefined
	return title.length > 500 ? `${title.slice(0, 497)}...` : title
}

function cleanSiteTitle(value: string): string {
	const parts = value.split(/\s+[|-]\s+/)
	return parts[parts.length - 1]?.trim() ?? value
}

function cleanDescription(value: unknown): string | undefined {
	const description = asString(value)?.replace(/\s+/g, ' ').trim()
	if (!description) return undefined
	return description.length > 1000 ? `${description.slice(0, 997)}...` : description
}

function titleizeSiteName(value: string): string {
	return value
		.replace(/[-_]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, '')
}

function asString(value: unknown): string | undefined {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || value instanceof Date) return String(value)
	return undefined
}

function normalizeTags(value: unknown): string[] {
	if (!value) return []
	if (Array.isArray(value)) return uniqueStrings(value.flatMap((entry) => normalizeTags(entry)))
	if (typeof value === 'string') {
		return uniqueStrings(
			value
				.split(',')
				.map((tag) => tag.trim())
				.filter(Boolean),
		)
	}
	return []
}

function uniqueStrings(values: Array<string | undefined>): string[] {
	return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => !!value))]
}

function metaContent(html: string, attributeNames: string[], values: string[]): string | undefined {
	return metaContents(html, attributeNames, values)[0]
}

function metaContents(html: string, attributeNames: string[], values: string[]): string[] {
	const tags = html.match(/<meta\b[^>]*>/gi) ?? []
	const expected = new Set(values.map((value) => value.toLowerCase()))

	return tags.flatMap((tag) => {
		const attributes = parseAttributes(tag)
		const matches = attributeNames.some((name) => {
			const value = attributes[name.toLowerCase()]
			return value ? expected.has(value.toLowerCase()) : false
		})

		return matches && attributes.content ? [decodeHtmlEntities(attributes.content)] : []
	})
}

function linkHref(html: string, rel: string): string | undefined {
	const tags = html.match(/<link\b[^>]*>/gi) ?? []

	for (const tag of tags) {
		const attributes = parseAttributes(tag)
		const rels = attributes.rel?.toLowerCase().split(/\s+/) ?? []
		if (rels.includes(rel) && attributes.href) {
			return decodeHtmlEntities(attributes.href)
		}
	}

	return undefined
}

function timeDatetime(html: string): string | undefined {
	const tags = html.match(/<time\b[^>]*>/gi) ?? []

	for (const tag of tags) {
		const datetime = parseAttributes(tag).datetime
		if (datetime) return decodeHtmlEntities(datetime)
	}

	return undefined
}

function textContentOfFirstTag(html: string, tagName: string): string | undefined {
	const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'))
	if (!match) return undefined
	return stripHtml(match[1] ?? '')
}

function extractArticleText(html: string): string | undefined {
	const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
	const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)
	const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
	const source = articleMatch?.[1] ?? mainMatch?.[1] ?? bodyMatch?.[1]
	if (!source) return undefined

	const stripped = stripHtml(
		source
			.replace(/<script\b[\s\S]*?<\/script>/gi, '')
			.replace(/<style\b[\s\S]*?<\/style>/gi, '')
			.replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
			.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ''),
	)

	return stripped.length > MAX_TEXT_CONTENT_LENGTH ? `${stripped.slice(0, MAX_TEXT_CONTENT_LENGTH - 3)}...` : stripped
}

function stripHtml(source: string): string {
	return decodeHtmlEntities(source.replace(/<[^>]+>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim()
}

function stripMarkdownForText(markdown: string): string {
	return markdown
		.replace(/#{1,6}\s/g, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\*([^*]+)\*/g, '$1')
		.replace(/!\[.*?\]\(.*?\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/`{3}[\s\S]*?`{3}/g, '')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\s+/g, ' ')
		.trim()
}

function parseAttributes(tag: string): Record<string, string> {
	const attributes: Record<string, string> = {}
	const attributePattern = /([A-Za-z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g

	let match = attributePattern.exec(tag)
	while (match) {
		attributes[match[1]!.toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '')
		match = attributePattern.exec(tag)
	}

	return attributes
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
}

function extractJsonLdObjects(html: string): Array<Record<string, unknown>> {
	const scripts = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? []

	return scripts.flatMap((script) => {
		const content = script.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '')
		try {
			return flattenJsonLd(JSON.parse(content))
		} catch {
			return []
		}
	})
}

function flattenJsonLd(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value)) return value.flatMap(flattenJsonLd)
	if (!value || typeof value !== 'object') return []

	const record = value as Record<string, unknown>
	const graph = Array.isArray(record['@graph']) ? record['@graph'].flatMap(flattenJsonLd) : []
	return [record, ...graph]
}

function hasJsonLdType(value: Record<string, unknown>, types: string[]): boolean {
	const jsonType = value['@type']
	const actualTypes = Array.isArray(jsonType) ? jsonType : [jsonType]
	return actualTypes.some((entry) => typeof entry === 'string' && types.includes(entry))
}

function jsonLdImage(value: Record<string, unknown> | undefined): string | undefined {
	const image = value?.image
	if (typeof image === 'string') return image
	if (Array.isArray(image)) return asString(image[0])
	if (image && typeof image === 'object') return asString((image as Record<string, unknown>).url)
	return undefined
}

function resolveAssetPath(input: string, routePath: string, siteUrl: string): string | undefined {
	try {
		const url = new URL(input, `${siteUrl}${routePath.endsWith('/') ? routePath : `${routePath}/`}`)
		const site = new URL(siteUrl)
		if (url.origin !== site.origin) return undefined
		const prefix = site.pathname.replace(/\/+$/, '')
		const pathname = decodeURIComponent(url.pathname)
		return normalizeSitePath(prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname)
	} catch {
		return normalizeSitePath(input)
	}
}

function absolutizeUrl(input: string, routePath: string, siteUrl: string): string | undefined {
	try {
		return new URL(input, `${siteUrl}${routePath.endsWith('/') ? routePath : `${routePath}/`}`).toString()
	} catch {
		return undefined
	}
}
