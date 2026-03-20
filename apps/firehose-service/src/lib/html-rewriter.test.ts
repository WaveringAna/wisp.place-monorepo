import { describe, expect, test } from 'bun:test'
import { isHtmlFile, rewriteHtmlPaths } from './html-rewriter'

const BASE = '/did:plc:abc123/mysite/'
const ROOT_DOC = 'index.html'
const NESTED_DOC = 'blog/posts/index.html'

function rewrite(html: string, doc = ROOT_DOC) {
	return rewriteHtmlPaths(html, BASE, doc)
}

describe('rewritten attributes', () => {
	test('src', () => {
		expect(rewrite('<img src="/photo.jpg">')).toBe('<img src="/did:plc:abc123/mysite/photo.jpg">')
	})

	test('href', () => {
		expect(rewrite('<a href="/about">About</a>')).toBe('<a href="/did:plc:abc123/mysite/about">About</a>')
	})

	test('action', () => {
		expect(rewrite('<form action="/submit"></form>')).toBe('<form action="/did:plc:abc123/mysite/submit"></form>')
	})

	test('data (object)', () => {
		expect(rewrite('<object data="/file.pdf"></object>')).toBe(
			'<object data="/did:plc:abc123/mysite/file.pdf"></object>',
		)
	})

	test('poster', () => {
		expect(rewrite('<video poster="/thumb.jpg"></video>')).toBe(
			'<video poster="/did:plc:abc123/mysite/thumb.jpg"></video>',
		)
	})

	test('link href', () => {
		expect(rewrite('<link rel="stylesheet" href="/style.css">')).toBe(
			'<link rel="stylesheet" href="/did:plc:abc123/mysite/style.css">',
		)
	})

	test('script src', () => {
		expect(rewrite('<script src="/app.js"></script>')).toBe('<script src="/did:plc:abc123/mysite/app.js"></script>')
	})

	test('source src', () => {
		expect(rewrite('<video><source src="/clip.mp4"></video>')).toBe(
			'<video><source src="/did:plc:abc123/mysite/clip.mp4"></video>',
		)
	})
})

describe('srcset', () => {
	test('single entry no descriptor', () => {
		expect(rewrite('<img srcset="/img.jpg">')).toBe('<img srcset="/did:plc:abc123/mysite/img.jpg">')
	})

	test('single entry with pixel density descriptor', () => {
		expect(rewrite('<img srcset="/img.jpg 2x">')).toBe('<img srcset="/did:plc:abc123/mysite/img.jpg 2x">')
	})

	test('multiple entries with pixel density descriptors', () => {
		expect(rewrite('<img srcset="/img.jpg 1x, /img@2x.jpg 2x">')).toBe(
			'<img srcset="/did:plc:abc123/mysite/img.jpg 1x, /did:plc:abc123/mysite/img@2x.jpg 2x">',
		)
	})

	test('multiple entries with width descriptors', () => {
		expect(rewrite('<img srcset="/small.jpg 320w, /large.jpg 1024w">')).toBe(
			'<img srcset="/did:plc:abc123/mysite/small.jpg 320w, /did:plc:abc123/mysite/large.jpg 1024w">',
		)
	})

	test('relative entries are left alone', () => {
		const html = '<img srcset="../img.jpg 1x, ./img@2x.jpg 2x">'
		expect(rewrite(html, NESTED_DOC)).toBe(html)
	})

	test('mixed: absolute entries rewritten, relative left alone', () => {
		expect(rewrite('<img srcset="/abs.jpg 1x, ./rel.jpg 2x">')).toBe(
			'<img srcset="/did:plc:abc123/mysite/abs.jpg 1x, ./rel.jpg 2x">',
		)
	})
})

describe('absolute (root-relative) paths', () => {
	test('root file', () => {
		expect(rewrite('<img src="/image.png">')).toBe('<img src="/did:plc:abc123/mysite/image.png">')
	})

	test('nested file', () => {
		expect(rewrite('<img src="/assets/photo.jpg">')).toBe('<img src="/did:plc:abc123/mysite/assets/photo.jpg">')
	})

	test('deeply nested file', () => {
		expect(rewrite('<link href="/a/b/c/style.css">')).toBe('<link href="/did:plc:abc123/mysite/a/b/c/style.css">')
	})

	test('same result regardless of which document it appears in', () => {
		const html = '<img src="/image.png">'
		const expected = '<img src="/did:plc:abc123/mysite/image.png">'
		expect(rewrite(html, ROOT_DOC)).toBe(expected)
		expect(rewrite(html, NESTED_DOC)).toBe(expected)
	})
})

describe('relative paths are not rewritten', () => {
	test('./ prefix', () => {
		const html = '<img src="./image.png">'
		expect(rewrite(html)).toBe(html)
	})

	test('bare filename', () => {
		const html = '<img src="image.png">'
		expect(rewrite(html)).toBe(html)
	})

	test('../ up one level', () => {
		const html = '<img src="../image.png">'
		expect(rewrite(html, NESTED_DOC)).toBe(html)
	})

	test('../../ up two levels', () => {
		const html = '<link href="../../style.css">'
		expect(rewrite(html, NESTED_DOC)).toBe(html)
	})

	test('../sibling/path', () => {
		const html = '<script src="../assets/app.js"></script>'
		expect(rewrite(html, NESTED_DOC)).toBe(html)
	})
})

describe('not rewritten', () => {
	describe('external / protocol-relative', () => {
		test('https', () => {
			const html = '<img src="https://cdn.example.com/img.png">'
			expect(rewrite(html)).toBe(html)
		})

		test('http', () => {
			const html = '<link href="http://cdn.example.com/style.css">'
			expect(rewrite(html)).toBe(html)
		})

		test('protocol-relative //', () => {
			const html = '<script src="//cdn.example.com/lib.js"></script>'
			expect(rewrite(html)).toBe(html)
		})
	})

	describe('URI schemes', () => {
		test('data:', () => {
			const html = '<img src="data:image/png;base64,abc123">'
			expect(rewrite(html)).toBe(html)
		})

		test('mailto:', () => {
			const html = '<a href="mailto:hi@example.com">Email</a>'
			expect(rewrite(html)).toBe(html)
		})

		test('tel:', () => {
			const html = '<a href="tel:+1234567890">Call</a>'
			expect(rewrite(html)).toBe(html)
		})

		test('javascript:', () => {
			const html = '<a href="javascript:void(0)">JS</a>'
			expect(rewrite(html)).toBe(html)
		})

		test('blob:', () => {
			const html = '<a href="blob:https://example.com/abc">Blob</a>'
			expect(rewrite(html)).toBe(html)
		})
	})

	describe('fragment-only', () => {
		test('#anchor', () => {
			const html = '<a href="#section">Jump</a>'
			expect(rewrite(html)).toBe(html)
		})
	})

	describe('already prefixed (Vite base output)', () => {
		test('path already starting with basePath is not double-rewritten', () => {
			const html = '<script src="/did:plc:abc123/mysite/assets/app.js"></script>'
			expect(rewrite(html)).toBe(html)
		})
	})

	describe('inline script and style content', () => {
		test('paths inside <script> text are not rewritten', () => {
			const html = '<script>\nvar path = "/api/data"\nfetch("/api/endpoint")\n</script>'
			expect(rewrite(html)).toBe(html)
		})

		test('url() inside <style> text is not rewritten', () => {
			const html = "<style>.hero { background: url('/images/hero.jpg') }</style>"
			expect(rewrite(html)).toBe(html)
		})
	})
})

describe('<base> tag', () => {
	test('root-relative base href is rewritten', () => {
		const result = rewrite('<head><base href="/"></head>')
		expect(result).toContain('href="/did:plc:abc123/mysite/"')
	})

	test('subdirectory base href is rewritten', () => {
		const result = rewrite('<head><base href="/app/"></head>')
		expect(result).toContain('href="/did:plc:abc123/mysite/app/"')
	})

	test('external base href is left untouched', () => {
		const html = '<head><base href="https://example.com/"></head>'
		expect(rewrite(html)).toBe(html)
	})

	test('relative base href is left untouched', () => {
		const html = '<head><base href="./subdir/"></head>'
		expect(rewrite(html)).toBe(html)
	})
})

describe('URL features preserved', () => {
	test('query string', () => {
		expect(rewrite('<img src="/img.png?v=3">')).toBe('<img src="/did:plc:abc123/mysite/img.png?v=3">')
	})

	test('hash fragment on a path URL', () => {
		expect(rewrite('<a href="/page#section">Link</a>')).toBe('<a href="/did:plc:abc123/mysite/page#section">Link</a>')
	})

	test('query string and hash fragment together', () => {
		expect(rewrite('<a href="/page?q=1#section">Link</a>')).toBe(
			'<a href="/did:plc:abc123/mysite/page?q=1#section">Link</a>',
		)
	})
})

describe('basePath normalisation', () => {
	test('basePath without trailing slash is normalised', () => {
		const result = rewriteHtmlPaths('<img src="/img.png">', '/did:plc:abc123/mysite', ROOT_DOC)
		expect(result).toBe('<img src="/did:plc:abc123/mysite/img.png">')
	})

	test('basePath with trailing slash is unchanged', () => {
		const result = rewriteHtmlPaths('<img src="/img.png">', '/did:plc:abc123/mysite/', ROOT_DOC)
		expect(result).toBe('<img src="/did:plc:abc123/mysite/img.png">')
	})
})

describe('real-world scenarios', () => {
	test('Vite SPA with already-prefixed paths not double-rewritten', () => {
		const html = [
			'<link rel="stylesheet" href="/did:plc:abc123/mysite/assets/index.css">',
			'<script src="/did:plc:abc123/mysite/assets/index.js"></script>',
		].join('\n')
		expect(rewrite(html)).toBe(html)
	})

	test('static site: absolute paths rewritten, relative paths left alone', () => {
		const html = `
<link href="/css/style.css" rel="stylesheet">
<script src="/js/main.js"></script>
<img src="/images/logo.png">
<img src="./post-image.jpg">
<a href="../index.html">Blog</a>
<a href="/index.html">Home</a>`.trim()

		const result = rewrite(html, NESTED_DOC)
		expect(result).toContain('href="/did:plc:abc123/mysite/css/style.css"')
		expect(result).toContain('src="/did:plc:abc123/mysite/js/main.js"')
		expect(result).toContain('src="/did:plc:abc123/mysite/images/logo.png"')
		expect(result).toContain('src="./post-image.jpg"')
		expect(result).toContain('href="../index.html"')
		expect(result).toContain('href="/did:plc:abc123/mysite/index.html"')
	})

	test('inline script alongside rewritable elements', () => {
		const html = `
<link href="/style.css" rel="stylesheet">
<script>
  var API = '/api/v1'
  fetch('/api/data').then(r => r.json())
</script>
<img src="/hero.jpg">`.trim()

		const result = rewrite(html)
		expect(result).toContain('href="/did:plc:abc123/mysite/style.css"')
		expect(result).toContain('src="/did:plc:abc123/mysite/hero.jpg"')
		expect(result).toContain("var API = '/api/v1'")
		expect(result).toContain("fetch('/api/data')")
	})
})

describe('isHtmlFile', () => {
	test('.html returns true', () => expect(isHtmlFile('index.html')).toBe(true))
	test('.htm returns true', () => expect(isHtmlFile('page.htm')).toBe(true))
	test('uppercase .HTML returns true', () => expect(isHtmlFile('INDEX.HTML')).toBe(true))
	test('nested path', () => expect(isHtmlFile('blog/posts/index.html')).toBe(true))
	test('.js returns false', () => expect(isHtmlFile('app.js')).toBe(false))
	test('no extension returns false', () => expect(isHtmlFile('README')).toBe(false))
})
