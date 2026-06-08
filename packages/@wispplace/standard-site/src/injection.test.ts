import { describe, expect, test } from 'bun:test'
import { buildStandardDocumentUri, documentRkeyForPath, injectStandardSiteDocumentLink } from './index'

describe('standard.site html injection', () => {
	test('builds deterministic document uris from paths', () => {
		const uri = buildStandardDocumentUri('did:plc:test', '/blog/hello')

		expect(uri).toBe(`at://did:plc:test/site.standard.document/${documentRkeyForPath('/blog/hello')}`)
	})

	test('injects a document link before the closing head tag', () => {
		const uri = buildStandardDocumentUri('did:plc:test', '/blog/hello')
		const result = injectStandardSiteDocumentLink('<html><head><title>x</title></head><body></body></html>', uri)

		expect(result.changed).toBe(true)
		expect(result.html).toContain(`<link rel="site.standard.document" href="${uri}" />`)
		expect(result.html.indexOf('rel="site.standard.document"')).toBeLessThan(result.html.indexOf('</head>'))
	})

	test('replaces an existing standard.site document link instead of duplicating it', () => {
		const uri = buildStandardDocumentUri('did:plc:test', '/blog/new')
		const html =
			'<html><head><link rel="site.standard.document" href="at://did:plc:test/site.standard.document/old"><title>x</title></head></html>'
		const result = injectStandardSiteDocumentLink(html, uri)

		expect(result.changed).toBe(true)
		expect(result.html.match(/rel="site\.standard\.document"/g)).toHaveLength(1)
		expect(result.html).toContain(`href="${uri}"`)
		expect(result.html).not.toContain('/old"')
	})

	test('leaves html without a head tag unchanged', () => {
		const result = injectStandardSiteDocumentLink('<article>just a fragment</article>', 'at://did/document')

		expect(result.changed).toBe(false)
		expect(result.html).toBe('<article>just a fragment</article>')
	})
})
