import { describe, expect, test } from 'bun:test'
import { isPreviewHostname, parsePreviewHostname } from './preview-host'

const PREVIEW = 'preview.wisp.place'

describe('parsePreviewHostname', () => {
	test('splits the rkey and the owner claim', () => {
		expect(parsePreviewHostname('pr-ab12cd3-yummers.preview.wisp.place', PREVIEW)).toEqual({
			rkey: 'pr-ab12cd3',
			claim: 'yummers',
		})
	})

	test('keeps hyphenated claims intact', () => {
		expect(parsePreviewHostname('pr-ab12cd3-my-site.preview.wisp.place', PREVIEW)).toEqual({
			rkey: 'pr-ab12cd3',
			claim: 'my-site',
		})
	})

	test.each([
		['apex', 'preview.wisp.place'],
		['other domain', 'pr-ab12cd3-yummers.example.com'],
		['lookalike suffix', 'pr-ab12cd3-yummers.evilpreview.wisp.place'],
		['nested host', 'x.pr-ab12cd3-yummers.preview.wisp.place'],
		['no pr prefix', 'ab12cd3-yummers.preview.wisp.place'],
		['no claim', 'pr-ab12cd3.preview.wisp.place'],
		['empty claim', 'pr-ab12cd3-.preview.wisp.place'],
		['short sha', 'pr-ab12cd-yummers.preview.wisp.place'],
		['long sha', 'pr-ab12cd3e-yummers.preview.wisp.place'],
		['non-hex sha', 'pr-ab12cdg-yummers.preview.wisp.place'],
		['uppercase sha', 'pr-AB12CD3-yummers.preview.wisp.place'],
		['double hyphen before claim', 'pr-ab12cd3--yummers.preview.wisp.place'],
		['label over 63 chars', `pr-ab12cd3-${'a'.repeat(60)}.preview.wisp.place`],
	])('rejects %s', (_name, host) => {
		expect(parsePreviewHostname(host, PREVIEW)).toBeNull()
	})
})

describe('isPreviewHostname', () => {
	test('covers the apex and everything beneath it only', () => {
		expect(isPreviewHostname('preview.wisp.place', PREVIEW)).toBe(true)
		expect(isPreviewHostname('anything.preview.wisp.place', PREVIEW)).toBe(true)
		expect(isPreviewHostname('evilpreview.wisp.place', PREVIEW)).toBe(false)
		expect(isPreviewHostname('wisp.place', PREVIEW)).toBe(false)
	})
})
