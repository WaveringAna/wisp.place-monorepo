import { describe, expect, test } from 'bun:test'
import {
	buildPublicationWellKnownFile,
	buildStandardPublicationUri,
	detectStandardSite,
	documentRkeyForPath,
} from './index'

describe('detectStandardSite', () => {
	test('detects dated html article pages from static output', () => {
		const result = detectStandardSite({
			siteUrl: 'https://sites.wisp.place/did:plc:abc/blog',
			siteName: 'my-blog',
			files: [
				{
					path: 'dist/index.html',
					content: '<title>my blog</title><meta name="description" content="notes from the void">',
					mimeType: 'text/html',
				},
				{
					path: 'dist/blog/hello/index.html',
					content: `
						<html>
							<head>
								<title>hello world | my blog</title>
								<meta property="og:type" content="article">
								<meta property="article:published_time" content="2026-05-20T10:00:00.000Z">
								<meta property="article:tag" content="atproto">
								<link rel="canonical" href="/did:plc:abc/blog/blog/hello/">
							</head>
							<body><article><h1>hello world</h1><p>this is a real post.</p></article></body>
						</html>
					`,
					mimeType: 'text/html',
				},
				{
					path: 'dist/tags/atproto/index.html',
					content: '<title>tag</title><time datetime="2026-05-20"></time>',
					mimeType: 'text/html',
				},
			],
		})

		expect(result.detected).toBe(true)
		expect(result.publication.name).toBe('my blog')
		expect(result.publication.description).toBe('notes from the void')
		expect(result.posts).toHaveLength(1)
		expect(result.posts[0]?.path).toBe('/blog/hello')
		expect(result.posts[0]?.title).toBe('hello world')
		expect(result.posts[0]?.tags).toEqual(['atproto'])
	})

	test('detects markdown frontmatter using sequoia-style date fallbacks', () => {
		const result = detectStandardSite({
			siteUrl: 'https://example.com',
			siteName: 'example',
			files: [
				{
					path: 'repo/src/content/blog/2026-01-03-post.md',
					content: `---
title: "post title"
pubDate: "2026-01-03"
tags:
  - bun
  - atproto
---
# post title

body **text**`,
				},
			],
		})

		expect(result.posts).toHaveLength(1)
		expect(result.posts[0]?.path).toBe('/post')
		expect(result.posts[0]?.tags).toEqual(['bun', 'atproto'])
		expect(result.posts[0]?.textContent).toBe('post title body text')
	})

	test('emits deterministic publication uri, well-known file, and document rkeys', () => {
		expect(buildStandardPublicationUri('did:plc:abc', 'blog')).toBe('at://did:plc:abc/site.standard.publication/blog')
		expect(buildPublicationWellKnownFile('did:plc:abc', 'blog')).toMatchObject({
			path: '.well-known/site.standard.publication',
			content: 'at://did:plc:abc/site.standard.publication/blog',
		})
		expect(documentRkeyForPath('/blog/hello')).toBe(documentRkeyForPath('/blog/hello'))
		expect(documentRkeyForPath('/blog/hello')).not.toBe(documentRkeyForPath('/blog/goodbye'))
	})
})
