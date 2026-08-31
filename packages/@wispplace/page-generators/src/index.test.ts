import { describe, expect, it } from 'bun:test'
import { generateDirectoryListing } from './index'

describe('generateDirectoryListing', () => {
	it('escapes untrusted paths and entry names in HTML text and attributes', () => {
		const path = 'current/<script>alert(1)</script>"&'
		const maliciousName = '"><img src=x onerror="alert(1)">'
		const html = generateDirectoryListing(path, [{ name: maliciousName, isDirectory: false }])

		expect(html).not.toContain('<script>alert(1)</script>')
		expect(html).not.toContain('<img src=x onerror="alert(1)">')
		expect(html).not.toContain(' onerror="alert(1)"')
		expect(html).toContain('Index of /current/&lt;script&gt;alert(1)&lt;/script&gt;&quot;&amp;')
		expect(html).toContain('&quot;&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
		expect(html).toContain('href="%22%3E%3Cimg%20src%3Dx%20onerror%3D%22alert%281%29%22%3E"')
	})

	it('uses an encoded relative URL segment while keeping parent navigation and folder slashes', () => {
		const name = 'javascript:alert(1) #?&<>"\''
		const html = generateDirectoryListing('nested', [{ name, isDirectory: true }])

		expect(html).toContain('<li><a href="../" class="parent">../</a></li>')
		expect(html).toContain('href="javascript%3Aalert%281%29%20%23%3F%26%3C%3E%22%27/" class="folder"')
		expect(html).not.toContain('href="javascript:')
		expect(html).toContain('javascript:alert(1) #?&amp;&lt;&gt;&quot;&#39;/')
	})
})
