import { describe, expect, test } from 'bun:test'
import { chooseStandardSitePublicationUrl } from './standard-site-publication-url'

describe('chooseStandardSitePublicationUrl', () => {
	const fallbackUrl = 'https://sites.wisp.place/did:plc:test/blog'

	test('prefers verified custom domains', () => {
		expect(
			chooseStandardSitePublicationUrl(
				[
					{ type: 'wisp', domain: 'ana.wisp.place' },
					{ type: 'custom', domain: 'blog.example.com', verified: true },
				],
				fallbackUrl,
			),
		).toBe('https://blog.example.com')
	})

	test('ignores unverified custom domains and falls back to wisp subdomain', () => {
		expect(
			chooseStandardSitePublicationUrl(
				[
					{ type: 'custom', domain: 'pending.example.com', verified: false },
					{ type: 'wisp', domain: 'ana.wisp.place' },
				],
				fallbackUrl,
			),
		).toBe('https://ana.wisp.place')
	})

	test('falls back to the sites.wisp.place site url', () => {
		expect(chooseStandardSitePublicationUrl([], fallbackUrl)).toBe(fallbackUrl)
	})
})
