import { describe, expect, test } from 'bun:test'
import { parseLexiconJson, parseWispTreeJson } from './public-json'
import type { Record as WispFsRecord } from './types/place/wisp/fs'
import { validateRecord } from './types/place/wisp/fs'
import type { Record as WispSubfsRecord } from './types/place/wisp/subfs'
import { validateRecord as validateSubfsRecord } from './types/place/wisp/subfs'

describe('parseLexiconJson', () => {
	test('hydrates public JSON blob references before lexicon validation', () => {
		const record = parseLexiconJson<WispFsRecord>({
			$type: 'place.wisp.fs',
			site: 'example',
			createdAt: '2026-07-14T00:00:00.000Z',
			root: {
				type: 'directory',
				entries: [
					{
						name: 'index.html',
						node: {
							$type: 'place.wisp.fs#file',
							type: 'file',
							blob: {
								$type: 'blob',
								ref: { $link: 'bafkreie56uer6qjm7mqckb52xtd3mecy77t5axnumzdcnhjzpcwiin6zue' },
								mimeType: 'text/html',
								size: 12,
							},
						},
					},
				],
			},
		})

		expect(validateRecord(record).success).toBe(true)
	})
})

const BLOB = {
	$type: 'blob',
	ref: { $link: 'bafkreie56uer6qjm7mqckb52xtd3mecy77t5axnumzdcnhjzpcwiin6zue' },
	mimeType: 'application/gzip',
	size: 12,
}

function untypedSite(root: unknown) {
	return { $type: 'place.wisp.fs', site: 'example', createdAt: '2026-04-04T01:41:13.202269+00:00', fileCount: 1, root }
}

describe('parseWispTreeJson', () => {
	test('a site whose nodes carry only `type` validates once $type is filled in', () => {
		const raw = untypedSite({
			type: 'directory',
			entries: [
				{ name: 'chart.png', node: { type: 'file', blob: BLOB, encoding: 'gzip', mimeType: 'image/png', base64: false } },
				{
					name: 'assets',
					node: {
						type: 'directory',
						entries: [
							{ name: 'a.css', node: { type: 'file', blob: BLOB } },
							{ name: 'more', node: { type: 'subfs', subject: 'at://did:plc:example/place.wisp.subfs/abc' } },
						],
					},
				},
			],
		})
		expect(validateRecord(parseLexiconJson<WispFsRecord>(raw)).success).toBe(false)

		const record = parseWispTreeJson<WispFsRecord>(raw, 'place.wisp.fs')
		expect(validateRecord(record).success).toBe(true)
		const nodes = record.root.entries.map((entry) => entry.node as { $type?: string; entries?: { node: { $type?: string } }[] })
		expect(nodes[0]?.$type).toBe('place.wisp.fs#file')
		expect(nodes[1]?.$type).toBe('place.wisp.fs#directory')
		expect(nodes[1]?.entries?.map((entry) => entry.node.$type)).toEqual(['place.wisp.fs#file', 'place.wisp.fs#subfs'])
	})

	test('subfs records get their own collection in $type', () => {
		const record = parseWispTreeJson<WispSubfsRecord>(
			{
				$type: 'place.wisp.subfs',
				createdAt: '2026-07-14T00:00:00.000Z',
				root: { type: 'directory', entries: [{ name: 'a.txt', node: { type: 'file', blob: BLOB } }] },
			},
			'place.wisp.subfs',
		)
		expect(validateSubfsRecord(record).success).toBe(true)
		expect((record.root.entries[0]?.node as { $type?: string }).$type).toBe('place.wisp.subfs#file')
	})

	test('a typed node is left alone, right or wrong', () => {
		const typed = { $type: 'place.wisp.fs#file', type: 'file', blob: BLOB }
		const good = parseWispTreeJson<WispFsRecord>(untypedSite({ type: 'directory', entries: [{ name: 'a', node: typed }] }), 'place.wisp.fs')
		expect(validateRecord(good).success).toBe(true)

		const wrong = { $type: 'place.wisp.fs#directory', type: 'file', blob: BLOB }
		const bad = parseWispTreeJson<WispFsRecord>(untypedSite({ type: 'directory', entries: [{ name: 'a', node: wrong }] }), 'place.wisp.fs')
		expect((bad.root.entries[0]?.node as { $type?: string }).$type).toBe('place.wisp.fs#directory')
		expect(validateRecord(bad).success).toBe(false)
	})

	test('unknown kinds and malformed shapes still fail validation without throwing', () => {
		for (const node of [{ type: 'symlink', target: 'x' }, { blob: BLOB }, 'file', null, 7]) {
			const record = parseWispTreeJson<WispFsRecord>(untypedSite({ type: 'directory', entries: [{ name: 'a', node }] }), 'place.wisp.fs')
			expect(validateRecord(record).success).toBe(false)
		}
		for (const root of [null, 'directory', { type: 'directory' }, { type: 'directory', entries: 'none' }, { type: 'directory', entries: [null, 3] }]) {
			expect(() => parseWispTreeJson<WispFsRecord>(untypedSite(root), 'place.wisp.fs')).not.toThrow()
		}
		expect(() => parseWispTreeJson<WispFsRecord>(null, 'place.wisp.fs')).not.toThrow()
	})
})
