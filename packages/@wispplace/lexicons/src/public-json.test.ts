import { describe, expect, test } from 'bun:test'
import { parseLexiconJson } from './public-json'
import type { Record as WispFsRecord } from './types/place/wisp/fs'
import { validateRecord } from './types/place/wisp/fs'

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
