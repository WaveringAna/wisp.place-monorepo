import { describe, expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import type { UploadedFile } from '@wispplace/fs-utils'
import { buildStandardDocumentUri, type DetectedStandardSitePost, type StaticSiteFile } from '@wispplace/standard-site'
import { injectStandardSiteLinksIntoUploadBuffers } from './standard-site-upload'

const did = 'did:plc:test'

function articleHtml(title = 'hello world'): string {
	return `<html><head><title>${title}</title><meta property="article:published_time" content="2026-01-02T00:00:00.000Z"></head><body><article><h1>${title}</h1></article></body></html>`
}

function post(overrides: Partial<DetectedStandardSitePost> = {}): DetectedStandardSitePost {
	return {
		filePath: 'blog/hello/index.html',
		path: '/blog/hello',
		title: 'hello world',
		publishedAt: '2026-01-02T00:00:00.000Z',
		...overrides,
	}
}

function uploadedHtml(path: string, html: string): UploadedFile {
	return {
		name: path,
		content: Buffer.from(html),
		mimeType: 'text/html',
		originalMimeType: 'text/html',
		size: Buffer.byteLength(html),
	}
}

function staticHtml(path: string, html: string): StaticSiteFile {
	return {
		path,
		content: Buffer.from(html),
		mimeType: 'text/html',
		size: Buffer.byteLength(html),
	}
}

function uploadedHtmlText(file: UploadedFile): string {
	return file.compressed ? gunzipSync(file.content).toString('utf8') : file.content.toString('utf8')
}

describe('injectStandardSiteLinksIntoUploadBuffers', () => {
	test('rewrites and compresses the exact html upload buffer', () => {
		const html = articleHtml()
		const uploadedFiles = [uploadedHtml('site/blog/hello/index.html', html)]
		const standardSiteFiles = [staticHtml('site/blog/hello/index.html', html)]

		const injected = injectStandardSiteLinksIntoUploadBuffers({
			did,
			posts: [post()],
			uploadedFiles,
			standardSiteFiles,
		})

		const documentUri = buildStandardDocumentUri(did, '/blog/hello')
		const uploadedArtifact = uploadedHtmlText(uploadedFiles[0]!)
		const standardSiteArtifact = Buffer.from(standardSiteFiles[0]!.content as Buffer).toString('utf8')

		expect(injected).toBe(1)
		expect(uploadedFiles[0]!.compressed).toBe(true)
		expect(uploadedArtifact).toContain(`<link rel="site.standard.document" href="${documentUri}" />`)
		expect(uploadedArtifact).toContain('</head>')
		expect(standardSiteArtifact).toBe(uploadedArtifact)
	})

	test('rewrites shared-root folder uploads before compression', () => {
		const html = articleHtml()
		const uploadedFiles = [
			uploadedHtml('dist/index.html', '<html><head><title>home</title></head><body></body></html>'),
			uploadedHtml('dist/blog/hello/index.html', html),
		]
		const standardSiteFiles = [
			staticHtml('dist/index.html', '<html><head><title>home</title></head><body></body></html>'),
			staticHtml('dist/blog/hello/index.html', html),
		]

		const injected = injectStandardSiteLinksIntoUploadBuffers({
			did,
			posts: [post()],
			uploadedFiles,
			standardSiteFiles,
		})

		const documentUri = buildStandardDocumentUri(did, '/blog/hello')
		const homeArtifact = uploadedHtmlText(uploadedFiles[0]!)
		const blogArtifact = uploadedHtmlText(uploadedFiles[1]!)

		expect(injected).toBe(1)
		expect(homeArtifact).not.toContain('site.standard.document')
		expect(uploadedFiles[1]!.compressed).toBe(true)
		expect(blogArtifact).toContain(`<link rel="site.standard.document" href="${documentUri}" />`)
	})

	test('matches route-derived html candidates when post filePath is not html', () => {
		const html = articleHtml()
		const uploadedFiles = [uploadedHtml('site/blog/hello/index.html', html)]
		const standardSiteFiles = [staticHtml('site/blog/hello/index.html', html)]

		const injected = injectStandardSiteLinksIntoUploadBuffers({
			did,
			posts: [post({ filePath: 'src/content/blog/hello.md' })],
			uploadedFiles,
			standardSiteFiles,
		})

		expect(injected).toBe(1)
		expect(uploadedHtmlText(uploadedFiles[0]!)).toContain('rel="site.standard.document"')
	})

	test('does not inject duplicate links when two detected posts resolve to the same html file', () => {
		const html = articleHtml()
		const uploadedFiles = [uploadedHtml('site/blog/hello/index.html', html)]
		const standardSiteFiles = [staticHtml('site/blog/hello/index.html', html)]

		const injected = injectStandardSiteLinksIntoUploadBuffers({
			did,
			posts: [post(), post({ title: 'duplicate title' })],
			uploadedFiles,
			standardSiteFiles,
		})

		const artifact = uploadedHtmlText(uploadedFiles[0]!)

		expect(injected).toBe(1)
		expect(artifact.match(/rel="site\.standard\.document"/g)).toHaveLength(1)
	})
})
