import { describe, expect, test } from 'bun:test'
import {
	buildScope,
	domainMappingChanges,
	eventsFilter,
	fromSettingsDraft,
	isPreviewSite,
	mappedDomainKeys,
	type ScopeDraft,
	scopePath,
	siteAddress,
	toPublicSite,
	toSettingsDraft,
	toWebhook,
} from './model'

describe('site settings', () => {
	test('reads the routing mode and cors origin from a stored record', () => {
		expect(
			toSettingsDraft({
				spaMode: 'app.html',
				cleanUrls: true,
				indexFiles: ['index.html', 'index.htm'],
				headers: [{ name: 'access-control-allow-origin', value: 'https://example.com' }],
			}),
		).toEqual({
			routing: 'spa',
			spaFile: 'app.html',
			notFoundFile: '404.html',
			indexFiles: 'index.html index.htm',
			cleanUrls: true,
			cors: true,
			corsOrigin: 'https://example.com',
		})
	})

	test('keeps headers the dashboard does not edit and swaps only the cors header', () => {
		const previous = {
			headers: [
				{ name: 'X-Frame-Options', value: 'DENY' },
				{ name: 'Access-Control-Allow-Origin', value: '*' },
				{ name: 'Cache-Control', value: 'no-store', path: '/api/*' },
			],
		}
		const draft = { ...toSettingsDraft(previous), corsOrigin: 'https://a.example' }
		expect(fromSettingsDraft(draft, previous).headers).toEqual([
			{ name: 'X-Frame-Options', value: 'DENY' },
			{ name: 'Cache-Control', value: 'no-store', path: '/api/*' },
			{ name: 'Access-Control-Allow-Origin', value: 'https://a.example' },
		])
		expect(fromSettingsDraft({ ...draft, cors: false }, previous).headers).toEqual([
			{ name: 'X-Frame-Options', value: 'DENY' },
			{ name: 'Cache-Control', value: 'no-store', path: '/api/*' },
		])
	})

	test('writes exactly one routing mode and always the required booleans', () => {
		const draft = toSettingsDraft({ spaMode: 'index.html', custom404: '404.html' })
		expect(fromSettingsDraft({ ...draft, routing: 'custom404', notFoundFile: ' oops.html ' }, {})).toEqual({
			directoryListing: false,
			cleanUrls: false,
			indexFiles: ['index.html'],
			custom404: 'oops.html',
		})
		expect(fromSettingsDraft({ ...draft, routing: 'directory' }, {})).toMatchObject({ directoryListing: true })
		expect(fromSettingsDraft({ ...draft, routing: 'directory' }, {})).not.toHaveProperty('spaMode')
	})

	test('splits index files on spaces or commas and never saves an empty list', () => {
		const draft = toSettingsDraft({})
		expect(fromSettingsDraft({ ...draft, indexFiles: 'a.html, b.html  c.html' }, {}).indexFiles).toEqual([
			'a.html',
			'b.html',
			'c.html',
		])
		expect(fromSettingsDraft({ ...draft, indexFiles: '  ' }, {}).indexFiles).toEqual(['index.html'])
	})
})

describe('domain mapping', () => {
	const wisp = [
		{ domain: 'a.wisp.place', rkey: 'blog' },
		{ domain: 'b.wisp.place', rkey: 'other' },
	]
	const custom = [
		{
			id: 'c1',
			domain: 'blog.example',
			did: 'did:x',
			rkey: 'blog',
			verified: true,
			last_verified_at: null,
			created_at: 0,
		},
	]

	test('finds the domains currently pointing at a site', () => {
		expect(mappedDomainKeys('blog', wisp, custom)).toEqual(new Set(['wisp:a.wisp.place', 'custom:c1']))
	})

	test('maps only what was added and releases only what was removed', () => {
		const current = mappedDomainKeys('blog', wisp, custom)
		expect(domainMappingChanges(current, new Set(['wisp:a.wisp.place', 'wisp:b.wisp.place']))).toEqual({
			map: ['wisp:b.wisp.place'],
			unmap: ['custom:c1'],
		})
	})
})

describe('sites', () => {
	test('prefers custom domains for the visible address', () => {
		const site = toPublicSite({
			did: 'did:x',
			rkey: 'blog',
			display_name: null,
			created_at: 1,
			updated_at: 2,
			domains: [
				{ type: 'wisp', domain: 'a.wisp.place' },
				{ type: 'custom', domain: 'blog.example' },
			],
		})
		expect(site.name).toBe('blog')
		expect(siteAddress(site, 'me.bsky.social')).toBe('blog.example')
		expect(siteAddress({ ...site, domains: [] }, 'me.bsky.social')).toBe('sites.wisp.place/me.bsky.social/blog')
	})
})

describe('webhooks', () => {
	const draft: ScopeDraft = { did: 'did:plc:me', app: null, path: '', other: 'all', collection: '', rkey: '' }

	test('builds scopes for known apps and for each "other" level', () => {
		expect(buildScope(draft)).toBe('')
		expect(buildScope({ ...draft, app: 'bluesky', path: ' app.bsky.* ' })).toBe('at://did:plc:me/app.bsky.*')
		expect(buildScope({ ...draft, app: 'other' })).toBe('at://did:plc:me')
		expect(buildScope({ ...draft, app: 'other', other: 'collection' })).toBe('')
		expect(buildScope({ ...draft, app: 'other', other: 'collection', collection: 'a.b.c' })).toBe(
			'at://did:plc:me/a.b.c',
		)
		expect(buildScope({ ...draft, app: 'other', other: 'record', collection: 'a.b.c' })).toBe('')
		expect(buildScope({ ...draft, app: 'other', other: 'record', collection: 'a.b.c', rkey: '3k' })).toBe(
			'at://did:plc:me/a.b.c/3k',
		)
	})

	test('sends every event as the empty list the api reads as "all"', () => {
		expect(eventsFilter(['create', 'update', 'delete'])).toEqual([])
		expect(eventsFilter(['create'])).toEqual(['create'])
	})

	test('normalizes stored records with defaults', () => {
		expect(toWebhook({ uri: 'at://did:plc:me/place.wisp.v2.wh/3k1' })).toEqual({
			rkey: '3k1',
			url: '',
			scope: '',
			backlinks: false,
			backlinksOnly: false,
			events: [],
			enabled: true,
			secretId: undefined,
		})
		expect(scopePath('at://did:plc:me/app.bsky.feed.post')).toBe('app.bsky.feed.post')
		expect(scopePath('at://did:plc:me')).toBe('all records')
	})
})

describe('isPreviewSite', () => {
	const site = (rkey: string) =>
		toPublicSite({ did: 'did:plc:a', rkey, display_name: null, created_at: 0, updated_at: 0 })

	test('matches only pr-<sha7> sites', () => {
		expect(isPreviewSite(site('pr-47598b7'))).toBe(true)
		expect(
			['pr-47598b', 'pr-47598b7x', 'pr-ABCDEF1', 'blog', 'pr-review'].map((rkey) => isPreviewSite(site(rkey))),
		).toEqual([false, false, false, false, false])
	})
})
