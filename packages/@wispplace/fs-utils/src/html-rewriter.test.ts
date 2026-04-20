import { describe, expect, test } from 'bun:test'
import { isHtmlContent, rewriteHtmlPaths } from './html-rewriter'

const BASE = '/did:plc:abc123/mysite/'

function rewrite(html: string): Promise<string> {
	return rewriteHtmlPaths(html, BASE)
}

describe('rewritten attributes', () => {
	test('src', async () => {
		expect(await rewrite('<img src="/photo.jpg">')).toBe('<img src="/did:plc:abc123/mysite/photo.jpg">')
	})

	test('href', async () => {
		expect(await rewrite('<a href="/about">About</a>')).toBe('<a href="/did:plc:abc123/mysite/about">About</a>')
	})

	test('action', async () => {
		expect(await rewrite('<form action="/submit"></form>')).toBe('<form action="/did:plc:abc123/mysite/submit"></form>')
	})

	test('data (object)', async () => {
		expect(await rewrite('<object data="/file.pdf"></object>')).toBe(
			'<object data="/did:plc:abc123/mysite/file.pdf"></object>',
		)
	})

	test('poster', async () => {
		expect(await rewrite('<video poster="/thumb.jpg"></video>')).toBe(
			'<video poster="/did:plc:abc123/mysite/thumb.jpg"></video>',
		)
	})

	test('link href', async () => {
		expect(await rewrite('<link rel="stylesheet" href="/style.css">')).toBe(
			'<link rel="stylesheet" href="/did:plc:abc123/mysite/style.css">',
		)
	})

	test('script src', async () => {
		expect(await rewrite('<script src="/app.js"></script>')).toBe(
			'<script src="/did:plc:abc123/mysite/app.js"></script>',
		)
	})

	test('source src', async () => {
		expect(await rewrite('<video><source src="/clip.mp4"></video>')).toBe(
			'<video><source src="/did:plc:abc123/mysite/clip.mp4"></video>',
		)
	})
})

describe('srcset', () => {
	test('single entry no descriptor', async () => {
		expect(await rewrite('<img srcset="/img.jpg">')).toBe('<img srcset="/did:plc:abc123/mysite/img.jpg">')
	})

	test('single entry with pixel density descriptor', async () => {
		expect(await rewrite('<img srcset="/img.jpg 2x">')).toBe('<img srcset="/did:plc:abc123/mysite/img.jpg 2x">')
	})

	test('multiple entries with pixel density descriptors', async () => {
		expect(await rewrite('<img srcset="/img.jpg 1x, /img@2x.jpg 2x">')).toBe(
			'<img srcset="/did:plc:abc123/mysite/img.jpg 1x, /did:plc:abc123/mysite/img@2x.jpg 2x">',
		)
	})

	test('multiple entries with width descriptors', async () => {
		expect(await rewrite('<img srcset="/small.jpg 320w, /large.jpg 1024w">')).toBe(
			'<img srcset="/did:plc:abc123/mysite/small.jpg 320w, /did:plc:abc123/mysite/large.jpg 1024w">',
		)
	})

	test('relative entries are left alone', async () => {
		const html = '<img srcset="../img.jpg 1x, ./img@2x.jpg 2x">'
		expect(await rewrite(html)).toBe(html)
	})

	test('mixed: absolute entries rewritten, relative left alone', async () => {
		expect(await rewrite('<img srcset="/abs.jpg 1x, ./rel.jpg 2x">')).toBe(
			'<img srcset="/did:plc:abc123/mysite/abs.jpg 1x, ./rel.jpg 2x">',
		)
	})
})

describe('absolute (root-relative) paths', () => {
	test('root file', async () => {
		expect(await rewrite('<img src="/image.png">')).toBe('<img src="/did:plc:abc123/mysite/image.png">')
	})

	test('nested file', async () => {
		expect(await rewrite('<img src="/assets/photo.jpg">')).toBe('<img src="/did:plc:abc123/mysite/assets/photo.jpg">')
	})

	test('deeply nested file', async () => {
		expect(await rewrite('<link href="/a/b/c/style.css">')).toBe('<link href="/did:plc:abc123/mysite/a/b/c/style.css">')
	})
})

describe('relative paths are not rewritten (browser resolves them against doc URL)', () => {
	test('./ prefix', async () => {
		const html = '<img src="./image.png">'
		expect(await rewrite(html)).toBe(html)
	})

	test('bare filename', async () => {
		const html = '<img src="image.png">'
		expect(await rewrite(html)).toBe(html)
	})

	test('../ up one level', async () => {
		const html = '<img src="../image.png">'
		expect(await rewrite(html)).toBe(html)
	})
})

describe('not rewritten', () => {
	describe('external / protocol-relative', () => {
		test('https', async () => {
			const html = '<img src="https://cdn.example.com/img.png">'
			expect(await rewrite(html)).toBe(html)
		})

		test('http', async () => {
			const html = '<link href="http://cdn.example.com/style.css">'
			expect(await rewrite(html)).toBe(html)
		})

		test('protocol-relative //', async () => {
			const html = '<script src="//cdn.example.com/lib.js"></script>'
			expect(await rewrite(html)).toBe(html)
		})
	})

	describe('URI schemes', () => {
		test('data:', async () => {
			const html = '<img src="data:image/png;base64,abc123">'
			expect(await rewrite(html)).toBe(html)
		})

		test('mailto:', async () => {
			const html = '<a href="mailto:hi@example.com">Email</a>'
			expect(await rewrite(html)).toBe(html)
		})

		test('tel:', async () => {
			const html = '<a href="tel:+1234567890">Call</a>'
			expect(await rewrite(html)).toBe(html)
		})

		test('javascript:', async () => {
			const html = '<a href="javascript:void(0)">JS</a>'
			expect(await rewrite(html)).toBe(html)
		})

		test('blob:', async () => {
			const html = '<a href="blob:https://example.com/abc">Blob</a>'
			expect(await rewrite(html)).toBe(html)
		})
	})

	describe('fragment-only', () => {
		test('#anchor', async () => {
			const html = '<a href="#section">Jump</a>'
			expect(await rewrite(html)).toBe(html)
		})
	})

	describe('already prefixed (Vite base output)', () => {
		test('path already starting with basePath is not double-rewritten', async () => {
			const html = '<script src="/did:plc:abc123/mysite/assets/app.js"></script>'
			expect(await rewrite(html)).toBe(html)
		})
	})

	describe('inline script and style content', () => {
		test('paths inside <script> text are not rewritten', async () => {
			const html = '<script>\nvar path = "/api/data"\nfetch("/api/endpoint")\n</script>'
			expect(await rewrite(html)).toBe(html)
		})

		test('url() inside <style> text is not rewritten', async () => {
			const html = "<style>.hero { background: url('/images/hero.jpg') }</style>"
			expect(await rewrite(html)).toBe(html)
		})
	})

	describe('custom elements and HTML-in-text', () => {
		test('custom element wrappers pass through unchanged', async () => {
			const html = '<md-block># Heading\n\nSome *markdown* with `<section>` and `<div>` in code spans.</md-block>'
			expect(await rewrite(html)).toBe(html)
		})
	})
})

describe('<base> tag', () => {
	test('root-relative base href is rewritten', async () => {
		const result = await rewrite('<head><base href="/"></head>')
		expect(result).toContain('href="/did:plc:abc123/mysite/"')
	})

	test('subdirectory base href is rewritten', async () => {
		const result = await rewrite('<head><base href="/app/"></head>')
		expect(result).toContain('href="/did:plc:abc123/mysite/app/"')
	})

	test('external base href is left untouched', async () => {
		const html = '<head><base href="https://example.com/"></head>'
		expect(await rewrite(html)).toBe(html)
	})

	test('relative base href is left untouched', async () => {
		const html = '<head><base href="./subdir/"></head>'
		expect(await rewrite(html)).toBe(html)
	})
})

describe('URL features preserved', () => {
	test('query string', async () => {
		expect(await rewrite('<img src="/img.png?v=3">')).toBe('<img src="/did:plc:abc123/mysite/img.png?v=3">')
	})

	test('hash fragment on a path URL', async () => {
		expect(await rewrite('<a href="/page#section">Link</a>')).toBe(
			'<a href="/did:plc:abc123/mysite/page#section">Link</a>',
		)
	})

	test('query string and hash fragment together', async () => {
		expect(await rewrite('<a href="/page?q=1#section">Link</a>')).toBe(
			'<a href="/did:plc:abc123/mysite/page?q=1#section">Link</a>',
		)
	})
})

describe('basePath normalisation', () => {
	test('basePath without trailing slash is normalised', async () => {
		const result = await rewriteHtmlPaths('<img src="/img.png">', '/did:plc:abc123/mysite')
		expect(result).toBe('<img src="/did:plc:abc123/mysite/img.png">')
	})

	test('basePath with trailing slash is unchanged', async () => {
		const result = await rewriteHtmlPaths('<img src="/img.png">', '/did:plc:abc123/mysite/')
		expect(result).toBe('<img src="/did:plc:abc123/mysite/img.png">')
	})
})

describe('real-world scenarios', () => {
	test('Vite SPA with already-prefixed paths not double-rewritten', async () => {
		const html = [
			'<link rel="stylesheet" href="/did:plc:abc123/mysite/assets/index.css">',
			'<script src="/did:plc:abc123/mysite/assets/index.js"></script>',
		].join('\n')
		expect(await rewrite(html)).toBe(html)
	})

	test('static site: absolute paths rewritten, relative paths left alone', async () => {
		const html = `
<link href="/css/style.css" rel="stylesheet">
<script src="/js/main.js"></script>
<img src="/images/logo.png">
<img src="./post-image.jpg">
<a href="../index.html">Blog</a>
<a href="/index.html">Home</a>`.trim()

		const result = await rewrite(html)
		expect(result).toContain('href="/did:plc:abc123/mysite/css/style.css"')
		expect(result).toContain('src="/did:plc:abc123/mysite/js/main.js"')
		expect(result).toContain('src="/did:plc:abc123/mysite/images/logo.png"')
		expect(result).toContain('src="./post-image.jpg"')
		expect(result).toContain('href="../index.html"')
		expect(result).toContain('href="/did:plc:abc123/mysite/index.html"')
	})

	test('inline script alongside rewritable elements', async () => {
		const html = `
<link href="/style.css" rel="stylesheet">
<script>
  var API = '/api/v1'
  fetch('/api/data').then(r => r.json())
</script>
<img src="/hero.jpg">`.trim()

		const result = await rewrite(html)
		expect(result).toContain('href="/did:plc:abc123/mysite/style.css"')
		expect(result).toContain('src="/did:plc:abc123/mysite/hero.jpg"')
		expect(result).toContain("var API = '/api/v1'")
		expect(result).toContain("fetch('/api/data')")
	})
})

describe('isHtmlContent', () => {
	test('identifies HTML by content type', () => {
		expect(isHtmlContent('file.txt', 'text/html')).toBe(true)
		expect(isHtmlContent('file.txt', 'text/html; charset=utf-8')).toBe(true)
	})

	test('.html extension', () => {
		expect(isHtmlContent('index.html')).toBe(true)
		expect(isHtmlContent('/path/to/file.html')).toBe(true)
	})

	test('.htm extension', () => {
		expect(isHtmlContent('page.htm')).toBe(true)
	})

	test('case-insensitive', () => {
		expect(isHtmlContent('INDEX.HTML')).toBe(true)
		expect(isHtmlContent('page.HTM')).toBe(true)
	})

	test('non-HTML', () => {
		expect(isHtmlContent('script.js')).toBe(false)
		expect(isHtmlContent('style.css')).toBe(false)
		expect(isHtmlContent('image.png')).toBe(false)
	})

	test('no extension', () => {
		expect(isHtmlContent('README')).toBe(false)
		expect(isHtmlContent('Makefile')).toBe(false)
	})
})
