import { describe, expect, test } from 'bun:test'
import type { SiteRequestEntry } from '@wispplace/observability'
import { recordSiteResponse, siteRequestEntry, statusClassFor } from './site-metrics'

const DID = 'did:plc:owner'

describe('statusClassFor', () => {
	test('buckets status codes into classes', () => {
		expect(statusClassFor(200)).toBe('2xx')
		expect(statusClassFor(304)).toBe('3xx')
		expect(statusClassFor(404)).toBe('4xx')
		expect(statusClassFor(503)).toBe('5xx')
	})

	test('ignores codes outside 2xx-5xx', () => {
		expect(statusClassFor(101)).toBeNull()
		expect(statusClassFor(600)).toBeNull()
	})
})

describe('siteRequestEntry', () => {
	test('marks html responses case-insensitively', () => {
		expect(siteRequestEntry(DID, 'blog', 'GET', 200, 'Text/HTML; charset=utf-8')).toEqual({
			ownerDid: DID,
			siteRkey: 'blog',
			statusClass: '2xx',
			html: true,
		})
		expect(siteRequestEntry(DID, 'blog', 'GET', 200, 'image/png')?.html).toBe(false)
		expect(siteRequestEntry(DID, 'blog', 'GET', 500, null)?.html).toBe(false)
	})

	test('only counts GETs against an identified site', () => {
		expect(siteRequestEntry(DID, 'blog', 'HEAD', 200, 'text/html')).toBeNull()
		expect(siteRequestEntry(DID, 'blog', 'POST', 200, 'text/html')).toBeNull()
		expect(siteRequestEntry('', 'blog', 'GET', 200, 'text/html')).toBeNull()
		expect(siteRequestEntry(DID, '', 'GET', 200, 'text/html')).toBeNull()
	})

	test('drops status codes with no class', () => {
		expect(siteRequestEntry(DID, 'blog', 'GET', 101, null)).toBeNull()
	})
})

describe('recordSiteResponse', () => {
	test('hands eligible responses to the recorder', () => {
		const seen: SiteRequestEntry[] = []
		recordSiteResponse(DID, 'blog', 'GET', 404, 'text/html', (e) => seen.push(e))
		recordSiteResponse(DID, 'blog', 'POST', 200, 'text/html', (e) => seen.push(e))
		expect(seen).toEqual([{ ownerDid: DID, siteRkey: 'blog', statusClass: '4xx', html: true }])
	})
})
