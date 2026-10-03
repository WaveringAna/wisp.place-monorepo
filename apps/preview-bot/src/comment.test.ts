import { describe, expect, test } from 'bun:test'
import { MAX_PREVIEW_ROWS, parsePreviewRows, renderComment } from './comment'

const row = (sha7: string, host = 'wispsites.dev') => ({ sha7, url: `https://pr-${sha7}-alice.${host}/` })

describe('renderComment', () => {
	test('lists the newest preview first and links it', () => {
		const body = renderComment([row('aaaaaaa'), row('bbbbbbb')])

		const lines = body.split('\n')
		expect(lines.findIndex((l) => l.includes('aaaaaaa'))).toBeLessThan(lines.findIndex((l) => l.includes('bbbbbbb')))
		expect(body).toContain('[https://pr-aaaaaaa-alice.wispsites.dev/](https://pr-aaaaaaa-alice.wispsites.dev/)')
		expect(body).toContain('`aaaaaaa`')
	})

	test('keeps only the newest rows', () => {
		const rows = Array.from({ length: MAX_PREVIEW_ROWS + 3 }, (_, i) => row(i.toString(16).padStart(7, '0')))

		const body = renderComment(rows)

		expect(parsePreviewRows(body)).toHaveLength(MAX_PREVIEW_ROWS)
		expect(body).toContain('0000000')
		expect(body).not.toContain(`0000${(MAX_PREVIEW_ROWS + 1).toString(16)}`)
	})
})

describe('parsePreviewRows', () => {
	test('reads back what renderComment wrote, in order', () => {
		const rows = [row('aaaaaaa'), row('bbbbbbb'), row('ccccccc')]

		expect(parsePreviewRows(renderComment(rows))).toEqual(rows)
	})

	test('ignores anything that is not a preview row', () => {
		const body = [
			'someone edited this',
			'| `abc` | [x](javascript:alert(1)) |',
			'| `ddddddd` | [https://evil.example/](https://evil.example/) |',
			'| `eeeeeee` | [https://pr-eeeeeee-alice.wispsites.dev/](https://pr-eeeeeee-alice.wispsites.dev/) |',
		].join('\n')

		expect(parsePreviewRows(body, 'wispsites.dev')).toEqual([row('eeeeeee')])
	})

	test('treats an empty or foreign body as no rows', () => {
		expect(parsePreviewRows('')).toEqual([])
		expect(parsePreviewRows('hello')).toEqual([])
	})
})
