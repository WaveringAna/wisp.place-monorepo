import { describe, test, expect } from 'bun:test'
import { rewriteHtmlPaths, isHtmlContent } from './html-rewriter'

describe('rewriteHtmlPaths', () => {
	const basePath = '/identifier/site/'

	describe('absolute paths', () => {
		test('rewrites absolute paths with leading slash', () => {
			const html = '<img src="/image.png">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})

		test('rewrites nested absolute paths', () => {
			const html = '<link href="/css/style.css">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<link href="/identifier/site/css/style.css">')
		})
	})

	describe('relative paths from root document', () => {
		test('rewrites relative paths with ./ prefix', () => {
			const html = '<img src="./image.png">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})

		test('rewrites relative paths without prefix', () => {
			const html = '<img src="image.png">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})

		test('rewrites relative paths with ../ (should stay at root)', () => {
			const html = '<img src="../image.png">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})
	})

	describe('relative paths from nested documents', () => {
		test('rewrites relative path from nested document', () => {
			const html = '<img src="./photo.jpg">'
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'folder1/folder2/index.html'
			)
			expect(result).toBe(
				'<img src="/identifier/site/folder1/folder2/photo.jpg">'
			)
		})

		test('rewrites plain filename from nested document', () => {
			const html = '<script src="app.js"></script>'
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'folder1/folder2/index.html'
			)
			expect(result).toBe(
				'<script src="/identifier/site/folder1/folder2/app.js"></script>'
			)
		})

		test('rewrites ../ to go up one level', () => {
			const html = '<img src="../image.png">'
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'folder1/folder2/folder3/index.html'
			)
			expect(result).toBe(
				'<img src="/identifier/site/folder1/folder2/image.png">'
			)
		})

		test('rewrites multiple ../ to go up multiple levels', () => {
			const html = '<link href="../../css/style.css">'
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'folder1/folder2/folder3/index.html'
			)
			expect(result).toBe(
				'<link href="/identifier/site/folder1/css/style.css">'
			)
		})

		test('rewrites ../ with additional path segments', () => {
			const html = '<img src="../assets/logo.png">'
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'pages/about/index.html'
			)
			expect(result).toBe(
				'<img src="/identifier/site/pages/assets/logo.png">'
			)
		})

		test('handles complex nested relative paths', () => {
			const html = '<script src="../../lib/vendor/jquery.js"></script>'
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'pages/blog/post/index.html'
			)
			expect(result).toBe(
				'<script src="/identifier/site/pages/lib/vendor/jquery.js"></script>'
			)
		})

		test('handles ../ going past root (stays at root)', () => {
			const html = '<img src="../../../image.png">'
			const result = rewriteHtmlPaths(html, basePath, 'folder1/index.html')
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})
	})

	describe('external URLs and special schemes', () => {
		test('does not rewrite http URLs', () => {
			const html = '<img src="http://example.com/image.png">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="http://example.com/image.png">')
		})

		test('does not rewrite https URLs', () => {
			const html = '<link href="https://cdn.example.com/style.css">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<link href="https://cdn.example.com/style.css">'
			)
		})

		test('does not rewrite protocol-relative URLs', () => {
			const html = '<script src="//cdn.example.com/script.js"></script>'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<script src="//cdn.example.com/script.js"></script>'
			)
		})

		test('does not rewrite data URIs', () => {
			const html =
				'<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA">'
			)
		})

		test('does not rewrite mailto links', () => {
			const html = '<a href="mailto:test@example.com">Email</a>'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<a href="mailto:test@example.com">Email</a>')
		})

		test('does not rewrite tel links', () => {
			const html = '<a href="tel:+1234567890">Call</a>'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<a href="tel:+1234567890">Call</a>')
		})
	})

	describe('different HTML attributes', () => {
		test('rewrites src attribute', () => {
			const html = '<img src="/image.png">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})

		test('rewrites href attribute', () => {
			const html = '<a href="/page.html">Link</a>'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<a href="/identifier/site/page.html">Link</a>')
		})

		test('rewrites action attribute', () => {
			const html = '<form action="/submit"></form>'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<form action="/identifier/site/submit"></form>')
		})

		test('rewrites data attribute', () => {
			const html = '<object data="/document.pdf"></object>'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<object data="/identifier/site/document.pdf"></object>'
			)
		})

		test('rewrites poster attribute', () => {
			const html = '<video poster="/thumbnail.jpg"></video>'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<video poster="/identifier/site/thumbnail.jpg"></video>'
			)
		})

		test('rewrites srcset attribute with single URL', () => {
			const html = '<img srcset="/image.png 1x">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<img srcset="/identifier/site/image.png 1x">'
			)
		})

		test('rewrites srcset attribute with multiple URLs', () => {
			const html = '<img srcset="/image-1x.png 1x, /image-2x.png 2x">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<img srcset="/identifier/site/image-1x.png 1x, /identifier/site/image-2x.png 2x">'
			)
		})

		test('rewrites srcset with width descriptors', () => {
			const html = '<img srcset="/small.jpg 320w, /large.jpg 1024w">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<img srcset="/identifier/site/small.jpg 320w, /identifier/site/large.jpg 1024w">'
			)
		})

		test('rewrites srcset with relative paths from nested document', () => {
			const html = '<img srcset="../img1.png 1x, ../img2.png 2x">'
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'folder1/folder2/index.html'
			)
			expect(result).toBe(
				'<img srcset="/identifier/site/folder1/img1.png 1x, /identifier/site/folder1/img2.png 2x">'
			)
		})
	})

	describe('quote handling', () => {
		test('handles double quotes', () => {
			const html = '<img src="/image.png">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})

		test('handles single quotes', () => {
			const html = "<img src='/image.png'>"
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe("<img src='/identifier/site/image.png'>")
		})

		test('handles mixed quotes in same document', () => {
			const html = '<img src="/img1.png"><link href=\'/style.css\'>'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<img src="/identifier/site/img1.png"><link href=\'/identifier/site/style.css\'>'
			)
		})
	})

	describe('multiple rewrites in same document', () => {
		test('rewrites multiple attributes in complex HTML', () => {
			const html = `
<!DOCTYPE html>
<html>
<head>
  <link href="/css/style.css" rel="stylesheet">
  <script src="/js/app.js"></script>
</head>
<body>
  <img src="/images/logo.png" alt="Logo">
  <a href="/about.html">About</a>
  <form action="/submit">
    <button type="submit">Submit</button>
  </form>
</body>
</html>
      `
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toContain('href="/identifier/site/css/style.css"')
			expect(result).toContain('src="/identifier/site/js/app.js"')
			expect(result).toContain('src="/identifier/site/images/logo.png"')
			expect(result).toContain('href="/identifier/site/about.html"')
			expect(result).toContain('action="/identifier/site/submit"')
		})

		test('handles mix of relative and absolute paths', () => {
			const html = `
        <img src="/abs/image.png">
        <img src="./rel/image.png">
        <img src="../parent/image.png">
        <img src="https://external.com/image.png">
      `
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'folder1/folder2/page.html'
			)
			expect(result).toContain('src="/identifier/site/abs/image.png"')
			expect(result).toContain(
				'src="/identifier/site/folder1/folder2/rel/image.png"'
			)
			expect(result).toContain(
				'src="/identifier/site/folder1/parent/image.png"'
			)
			expect(result).toContain('src="https://external.com/image.png"')
		})
	})

	describe('edge cases', () => {
		test('handles empty src attribute', () => {
			const html = '<img src="">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="">')
		})

		test('handles basePath without trailing slash', () => {
			const html = '<img src="/image.png">'
			const result = rewriteHtmlPaths(html, '/identifier/site', 'index.html')
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})

		test('handles basePath with trailing slash', () => {
			const html = '<img src="/image.png">'
			const result = rewriteHtmlPaths(
				html,
				'/identifier/site/',
				'index.html'
			)
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})

		test('handles whitespace around equals sign', () => {
			const html = '<img src  =  "/image.png">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="/identifier/site/image.png">')
		})

		test('preserves query strings in URLs', () => {
			const html = '<img src="/image.png?v=123">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe('<img src="/identifier/site/image.png?v=123">')
		})

		test('preserves hash fragments in URLs', () => {
			const html = '<a href="/page.html#section">Link</a>'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<a href="/identifier/site/page.html#section">Link</a>'
			)
		})

		test('handles paths with special characters', () => {
			const html = '<img src="/folder-name/file_name.png">'
			const result = rewriteHtmlPaths(html, basePath, 'index.html')
			expect(result).toBe(
				'<img src="/identifier/site/folder-name/file_name.png">'
			)
		})
	})

	describe('real-world scenario', () => {
		test('handles the example from the bug report', () => {
			// HTML file at: /folder1/folder2/folder3/index.html
			// Image at: /folder1/folder2/img.png
			// Reference: src="../img.png"
			const html = '<img src="../img.png">'
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'folder1/folder2/folder3/index.html'
			)
			expect(result).toBe(
				'<img src="/identifier/site/folder1/folder2/img.png">'
			)
		})

		test('handles deeply nested static site structure', () => {
			// A typical static site with nested pages and shared assets
			const html = `
<!DOCTYPE html>
<html>
<head>
  <link href="../../css/style.css" rel="stylesheet">
  <link href="../../css/theme.css" rel="stylesheet">
  <script src="../../js/main.js"></script>
</head>
<body>
  <img src="../../images/logo.png" alt="Logo">
  <img src="./post-image.jpg" alt="Post">
  <a href="../index.html">Back to Blog</a>
  <a href="../../index.html">Home</a>
</body>
</html>
      `
			const result = rewriteHtmlPaths(
				html,
				basePath,
				'blog/posts/my-post.html'
			)

			// Assets two levels up
			expect(result).toContain('href="/identifier/site/css/style.css"')
			expect(result).toContain('href="/identifier/site/css/theme.css"')
			expect(result).toContain('src="/identifier/site/js/main.js"')
			expect(result).toContain('src="/identifier/site/images/logo.png"')

			// Same directory
			expect(result).toContain(
				'src="/identifier/site/blog/posts/post-image.jpg"'
			)

			// One level up
			expect(result).toContain('href="/identifier/site/blog/index.html"')

			// Two levels up
			expect(result).toContain('href="/identifier/site/index.html"')
		})
	})
})

describe('isHtmlContent', () => {
	test('identifies HTML by content type', () => {
		expect(isHtmlContent('file.txt', 'text/html')).toBe(true)
		expect(isHtmlContent('file.txt', 'text/html; charset=utf-8')).toBe(
			true
		)
	})

	test('identifies HTML by .html extension', () => {
		expect(isHtmlContent('index.html')).toBe(true)
		expect(isHtmlContent('page.html', undefined)).toBe(true)
		expect(isHtmlContent('/path/to/file.html')).toBe(true)
	})

	test('identifies HTML by .htm extension', () => {
		expect(isHtmlContent('index.htm')).toBe(true)
		expect(isHtmlContent('page.htm', undefined)).toBe(true)
	})

	test('handles case-insensitive extensions', () => {
		expect(isHtmlContent('INDEX.HTML')).toBe(true)
		expect(isHtmlContent('page.HTM')).toBe(true)
		expect(isHtmlContent('File.HtMl')).toBe(true)
	})

	test('returns false for non-HTML files', () => {
		expect(isHtmlContent('script.js')).toBe(false)
		expect(isHtmlContent('style.css')).toBe(false)
		expect(isHtmlContent('image.png')).toBe(false)
		expect(isHtmlContent('data.json')).toBe(false)
	})

	test('returns false for files with no extension', () => {
		expect(isHtmlContent('README')).toBe(false)
		expect(isHtmlContent('Makefile')).toBe(false)
	})
})
