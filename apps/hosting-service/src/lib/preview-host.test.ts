import { describe, expect, test } from 'bun:test'
import { isPreviewHostname, parsePreviewHostname } from './preview-host'

const PREVIEW = 'wispsites.dev'

describe('parsePreviewHostname', () => {
	test('splits the rkey and the owner claim', () => {
		expect(parsePreviewHostname('pr-ab12cd3-yummers.wispsites.dev', PREVIEW)).toEqual({
			rkey: 'pr-ab12cd3',
			claim: 'yummers',
		})
	})

	test('keeps hyphenated claims intact', () => {
		expect(parsePreviewHostname('pr-ab12cd3-my-site.wispsites.dev', PREVIEW)).toEqual({
			rkey: 'pr-ab12cd3',
			claim: 'my-site',
		})
	})

	test.each([
		['apex', 'wispsites.dev'],
		['other domain', 'pr-ab12cd3-yummers.example.com'],
		['lookalike suffix', 'pr-ab12cd3-yummers.evilwispsites.dev'],
		['nested host', 'x.pr-ab12cd3-yummers.wispsites.dev'],
		['no pr prefix', 'ab12cd3-yummers.wispsites.dev'],
		['no claim', 'pr-ab12cd3.wispsites.dev'],
		['empty claim', 'pr-ab12cd3-.wispsites.dev'],
		['short sha', 'pr-ab12cd-yummers.wispsites.dev'],
		['long sha', 'pr-ab12cd3e-yummers.wispsites.dev'],
		['non-hex sha', 'pr-ab12cdg-yummers.wispsites.dev'],
		['uppercase sha', 'pr-AB12CD3-yummers.wispsites.dev'],
		['double hyphen before claim', 'pr-ab12cd3--yummers.wispsites.dev'],
		['label over 63 chars', `pr-ab12cd3-${'a'.repeat(60)}.wispsites.dev`],
	])('rejects %s', (_name, host) => {
		expect(parsePreviewHostname(host, PREVIEW)).toBeNull()
	})
})

describe('isPreviewHostname', () => {
	test('covers the apex and everything beneath it only', () => {
		expect(isPreviewHostname('wispsites.dev', PREVIEW)).toBe(true)
		expect(isPreviewHostname('anything.wispsites.dev', PREVIEW)).toBe(true)
		expect(isPreviewHostname('evilwispsites.dev', PREVIEW)).toBe(false)
		expect(isPreviewHostname('wisp.place', PREVIEW)).toBe(false)
	})
})
