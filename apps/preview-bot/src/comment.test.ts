import { describe, expect, test } from 'bun:test'
import { MAX_PREVIEW_ROWS, parsePreviewRows, renderComment } from './comment'

const REPO = { owner: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', name: 'blog' }
const row = (sha7: string, host = 'preview.wisp.place') => ({
	sha7,
	sha: sha7.padEnd(40, '0'),
	url: `https://pr-${sha7}-alice.${host}/`,
})

describe('renderComment', () => {
	test('lists the newest preview first and links it and its commit', () => {
		const body = renderComment([row('aaaaaaa'), row('bbbbbbb')], REPO)

		const lines = body.split('\n')
		expect(lines[0]).toBe('**preview deploys**')
		expect(lines.findIndex((l) => l.includes('aaaaaaa'))).toBeLessThan(lines.findIndex((l) => l.includes('bbbbbbb')))
		expect(body).toContain(
			`| [\`aaaaaaa\`](https://tangled.org/${REPO.owner}/blog/commit/aaaaaaa${'0'.repeat(33)}) | [open preview](https://pr-aaaaaaa-alice.preview.wisp.place/) |`,
		)
	})

	test('keeps only the newest rows', () => {
		const rows = Array.from({ length: MAX_PREVIEW_ROWS + 3 }, (_, i) => row(i.toString(16).padStart(7, '0')))

		const body = renderComment(rows, REPO)

		expect(parsePreviewRows(body)).toHaveLength(MAX_PREVIEW_ROWS)
		expect(body).toContain('0000000')
		expect(body).not.toContain(`0000${(MAX_PREVIEW_ROWS + 1).toString(16)}`)
	})
})

describe('parsePreviewRows', () => {
	test('reads back what renderComment wrote, in order', () => {
		const rows = [row('aaaaaaa'), row('bbbbbbb'), row('ccccccc')]

		expect(parsePreviewRows(renderComment(rows, REPO))).toEqual(rows)
	})

	test('carries rows written before commits were linked, and links them by their short sha', () => {
		const legacy =
			'| `ddddddd` | [https://pr-ddddddd-alice.preview.wisp.place/](https://pr-ddddddd-alice.preview.wisp.place/) |'
		const rows = parsePreviewRows(legacy, 'preview.wisp.place')

		expect(rows).toEqual([{ sha7: 'ddddddd', sha: 'ddddddd', url: 'https://pr-ddddddd-alice.preview.wisp.place/' }])
		expect(renderComment(rows, REPO)).toContain(`(https://tangled.org/${REPO.owner}/blog/commit/ddddddd)`)
	})

	test('keeps only the sha of a commit link, so an edited link is rebuilt', () => {
		const edited =
			'| [`aaaaaaa`](https://tangled.org/evil/repo/commit/aaaaaaa) | [open preview](https://pr-aaaaaaa-alice.preview.wisp.place/) |'
		const rendered = renderComment(parsePreviewRows(edited), REPO)

		expect(rendered).toContain(`(https://tangled.org/${REPO.owner}/blog/commit/aaaaaaa)`)
		expect(rendered).not.toContain('evil')
	})

	test('ignores anything that is not a preview row', () => {
		const body = [
			'someone edited this',
			'| `abc` | [x](javascript:alert(1)) |',
			'| `ddddddd` | [https://evil.example/](https://evil.example/) |',
			'| [`fffffff`](https://tangled.org/x/y/commit/0000000) | [open preview](https://pr-fffffff-alice.preview.wisp.place/) |',
			'| [`fffffff`](https://tangled.org/x/y/commit/fffffff) | [open preview](https://evil.example/) |',
			'| `eeeeeee` | [https://pr-eeeeeee-alice.preview.wisp.place/](https://pr-eeeeeee-alice.preview.wisp.place/) |',
		].join('\n')

		expect(parsePreviewRows(body, 'preview.wisp.place')).toEqual([{ ...row('eeeeeee'), sha: 'eeeeeee' }])
	})

	test('treats an empty or foreign body as no rows', () => {
		expect(parsePreviewRows('')).toEqual([])
		expect(parsePreviewRows('hello')).toEqual([])
	})
})
