import { describe, expect, it } from 'bun:test'
import {
	MAX_REDIRECT_FILE_BYTES,
	matchRedirectRule,
	parseQueryString,
	parseRedirectsFile,
	parseRedirectsFileBytes,
} from './redirects'

describe('parseRedirectsFile', () => {
	it('should parse simple redirects', () => {
		const content = `
# Comment line
/old-path /new-path
/home / 301
`
		const rules = parseRedirectsFile(content)
		expect(rules).toHaveLength(2)
		expect(rules[0]).toMatchObject({
			from: '/old-path',
			to: '/new-path',
			status: 301,
			force: false,
		})
		expect(rules[1]).toMatchObject({
			from: '/home',
			to: '/',
			status: 301,
			force: false,
		})
	})

	it('should parse redirects with different status codes', () => {
		const content = `
/temp-redirect /target 302
/rewrite /content 200
/not-found /404 404
`
		const rules = parseRedirectsFile(content)
		expect(rules).toHaveLength(3)
		expect(rules[0]?.status).toBe(302)
		expect(rules[1]?.status).toBe(200)
		expect(rules[2]?.status).toBe(404)
	})

	it('should parse force redirects', () => {
		const content = `/force-path /target 301!`
		const rules = parseRedirectsFile(content)
		expect(rules[0]?.force).toBe(true)
		expect(rules[0]?.status).toBe(301)
	})

	it('should parse splat redirects', () => {
		const content = `/news/* /blog/:splat`
		const rules = parseRedirectsFile(content)
		expect(rules[0]?.from).toBe('/news/*')
		expect(rules[0]?.to).toBe('/blog/:splat')
	})

	it('should reject splats that can cause regex backtracking', () => {
		const content = `
/safe/* /target/:splat
/nested/*/suffix /target
/*/*/*/*/*/*/*/*/x /target
`
		const rules = parseRedirectsFile(content)

		expect(rules).toHaveLength(1)
		expect(rules[0]?.from).toBe('/safe/*')
	})

	it('should parse placeholder redirects', () => {
		const content = `/blog/:year/:month/:day /posts/:year-:month-:day`
		const rules = parseRedirectsFile(content)
		expect(rules[0]?.from).toBe('/blog/:year/:month/:day')
		expect(rules[0]?.to).toBe('/posts/:year-:month-:day')
	})

	it('should parse country-based redirects', () => {
		const content = `/ /anz 302 Country=au,nz`
		const rules = parseRedirectsFile(content)
		expect(rules[0]?.conditions?.country).toEqual(['au', 'nz'])
	})

	it('should parse language-based redirects', () => {
		const content = `/products /en/products 301 Language=en`
		const rules = parseRedirectsFile(content)
		expect(rules[0]?.conditions?.language).toEqual(['en'])
	})

	it('should parse cookie-based redirects', () => {
		const content = `/* /legacy/:splat 200 Cookie=is_legacy,my_cookie`
		const rules = parseRedirectsFile(content)
		expect(rules[0]?.conditions?.cookie).toEqual(['is_legacy', 'my_cookie'])
	})
})

describe('parseRedirectsFileBytes', () => {
	it('rejects an oversized buffer before decoding or parsing it', () => {
		const data = new Uint8Array(MAX_REDIRECT_FILE_BYTES + 1_024)
		data.set(new TextEncoder().encode('/valid /target 301\n/partial /must-not-apply'))
		let decodeCalls = 0

		const rules = parseRedirectsFileBytes(data, () => {
			decodeCalls++
			return '/valid /target 301\n/partial /must-not-apply'
		})

		expect(rules).toBeNull()
		expect(decodeCalls).toBe(0)
	})

	it('decodes and parses a buffer at the inclusive shared byte limit', () => {
		const data = new Uint8Array(MAX_REDIRECT_FILE_BYTES)
		let decodedBytes = 0

		const rules = parseRedirectsFileBytes(data, (bytes) => {
			decodedBytes = bytes.byteLength
			return '/old /new 301'
		})

		expect(decodedBytes).toBe(MAX_REDIRECT_FILE_BYTES)
		expect(rules).toHaveLength(1)
		expect(rules?.[0]).toMatchObject({ from: '/old', to: '/new', status: 301 })
	})
})

describe('matchRedirectRule', () => {
	it('should match exact paths', () => {
		const rules = parseRedirectsFile('/old-path /new-path')
		const match = matchRedirectRule('/old-path', rules)
		expect(match).toBeTruthy()
		expect(match?.targetPath).toBe('/new-path')
		expect(match?.status).toBe(301)
	})

	it('should match paths with trailing slash', () => {
		const rules = parseRedirectsFile('/old-path /new-path')
		const match = matchRedirectRule('/old-path/', rules)
		expect(match).toBeTruthy()
		expect(match?.targetPath).toBe('/new-path')
	})

	it('should match splat patterns', () => {
		const rules = parseRedirectsFile('/news/* /blog/:splat')
		const match = matchRedirectRule('/news/2024/01/15/my-post', rules)
		expect(match).toBeTruthy()
		expect(match?.targetPath).toBe('/blog/2024/01/15/my-post')
	})

	it('should match placeholder patterns', () => {
		const rules = parseRedirectsFile('/blog/:year/:month/:day /posts/:year-:month-:day')
		const match = matchRedirectRule('/blog/2024/01/15', rules)
		expect(match).toBeTruthy()
		expect(match?.targetPath).toBe('/posts/2024-01-15')
	})

	it('should preserve query strings for 301/302 redirects', () => {
		const rules = parseRedirectsFile('/old /new 301')
		const match = matchRedirectRule('/old', rules, {
			queryParams: { foo: 'bar', baz: 'qux' },
		})
		expect(match?.targetPath).toContain('?')
		expect(match?.targetPath).toContain('foo=bar')
		expect(match?.targetPath).toContain('baz=qux')
	})

	it('should match based on query parameters', () => {
		const rules = parseRedirectsFile('/store id=:id /blog/:id 301')
		const match = matchRedirectRule('/store', rules, {
			queryParams: { id: 'my-post' },
		})
		expect(match).toBeTruthy()
		expect(match?.targetPath).toContain('/blog/my-post')
	})

	it('should match inline query parameter placeholders', () => {
		const rules = parseRedirectsFile(
			'/.well-known/webfinger?resource=:resource https://webfinger.example.com/?resource=:resource 200',
		)
		const match = matchRedirectRule('/.well-known/webfinger', rules, {
			queryParams: { resource: 'acct:ana@example.com' },
		})

		expect(match?.status).toBe(200)
		expect(match?.targetPath).toBe('https://webfinger.example.com/?resource=acct%3Aana%40example.com')
	})

	it('should not match when query params are missing', () => {
		const rules = parseRedirectsFile('/store id=:id /blog/:id 301')
		const match = matchRedirectRule('/store', rules, {
			queryParams: {},
		})
		expect(match).toBeNull()
	})

	it('should match based on country header', () => {
		const rules = parseRedirectsFile('/ /aus 302 Country=au')
		const match = matchRedirectRule('/', rules, {
			headers: { 'cf-ipcountry': 'AU' },
		})
		expect(match).toBeTruthy()
		expect(match?.targetPath).toBe('/aus')
	})

	it('should not match wrong country', () => {
		const rules = parseRedirectsFile('/ /aus 302 Country=au')
		const match = matchRedirectRule('/', rules, {
			headers: { 'cf-ipcountry': 'US' },
		})
		expect(match).toBeNull()
	})

	it('should match based on language header', () => {
		const rules = parseRedirectsFile('/products /en/products 301 Language=en')
		const match = matchRedirectRule('/products', rules, {
			headers: { 'accept-language': 'en-US,en;q=0.9' },
		})
		expect(match).toBeTruthy()
		expect(match?.targetPath).toBe('/en/products')
	})

	it('should match based on cookie presence', () => {
		const rules = parseRedirectsFile('/* /legacy/:splat 200 Cookie=is_legacy')
		const match = matchRedirectRule('/some-path', rules, {
			cookies: { is_legacy: 'true' },
		})
		expect(match).toBeTruthy()
		expect(match?.targetPath).toBe('/legacy/some-path')
	})

	it('should return first matching rule', () => {
		const content = `
/path /first
/path /second
`
		const rules = parseRedirectsFile(content)
		const match = matchRedirectRule('/path', rules)
		expect(match?.targetPath).toBe('/first')
	})

	it('should match more specific rules before general ones', () => {
		const content = `
/jobs/customer-ninja /careers/support
/jobs/* /careers/:splat
`
		const rules = parseRedirectsFile(content)

		const match1 = matchRedirectRule('/jobs/customer-ninja', rules)
		expect(match1?.targetPath).toBe('/careers/support')

		const match2 = matchRedirectRule('/jobs/developer', rules)
		expect(match2?.targetPath).toBe('/careers/developer')
	})

	it('should handle SPA routing pattern', () => {
		const rules = parseRedirectsFile('/* /index.html 200')

		const match1 = matchRedirectRule('/about', rules)
		expect(match1).toBeTruthy()
		expect(match1?.targetPath).toBe('/index.html')
		expect(match1?.status).toBe(200)

		const match2 = matchRedirectRule('/users/123/profile', rules)
		expect(match2).toBeTruthy()
		expect(match2?.targetPath).toBe('/index.html')
		expect(match2?.status).toBe(200)

		const match3 = matchRedirectRule('/', rules)
		expect(match3).toBeTruthy()
		expect(match3?.targetPath).toBe('/index.html')
	})
})

describe('redirect parser safety', () => {
	it('rejects ambiguous adjacent placeholders and handles a long nonmatch within a practical bound', () => {
		const adjacentPattern = `/${Array.from({ length: 32 }, (_, index) => `:part${index}`).join('')}/expected`
		const boundedPattern = `/${Array.from({ length: 32 }, (_, index) => `:part${index}`).join('/')}/expected`
		const longNonMatch = `/${Array.from({ length: 32 }, () => 'x'.repeat(180)).join('/')}/actual`

		const startedAt = performance.now()
		expect(parseRedirectsFile(`${adjacentPattern} /target`)).toHaveLength(0)

		const rules = parseRedirectsFile(`${boundedPattern} /target`)
		expect(rules).toHaveLength(1)
		expect(matchRedirectRule(longNonMatch, rules)).toBeNull()
		expect(performance.now() - startedAt).toBeLessThan(250)
	})

	it('does not accept a final rule from a truncated redirect file', () => {
		const retainedRule = '/kept /target 301\n'
		const finalRule = '/partial /must-not-apply 302'
		const commentLength = MAX_REDIRECT_FILE_BYTES - retainedRule.length - finalRule.length - 2
		const content = `${retainedRule}#${'x'.repeat(commentLength)}\n${finalRule} trailing bytes`

		expect(content.indexOf(finalRule) + finalRule.length).toBe(MAX_REDIRECT_FILE_BYTES)
		const rules = parseRedirectsFile(content)
		expect(rules).toHaveLength(1)
		expect(rules[0]).toMatchObject({ from: '/kept', to: '/target', status: 301 })
	})
})

describe('parseQueryString', () => {
	it('keeps malformed percent escapes verbatim and preserves values containing equals signs', () => {
		const params = parseQueryString('/search?malformed=%E0%A4%A&value=a=b=c&flag&empty=&=ignored')

		expect(params.malformed).toBe('%E0%A4%A')
		expect(params.value).toBe('a=b=c')
		expect(params.flag).toBe('')
		expect(params.empty).toBe('')
		expect(params['']).toBeUndefined()
	})

	it('uses the same total parsing behavior for inline redirect query conditions', () => {
		const rules = parseRedirectsFile('/search?malformed=%E0%A4%A&value=a=b=c /target 404')
		const queryParams = parseQueryString('/search?malformed=%E0%A4%A&value=a=b=c')

		expect(rules).toHaveLength(1)
		expect(matchRedirectRule('/search', rules, { queryParams })?.targetPath).toBe('/target')
	})
})
