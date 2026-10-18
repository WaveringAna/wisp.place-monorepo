import { describe, expect, test } from 'bun:test'
import { withoutSignedInRedirect } from './landing-page'

const landingPage = await Bun.file(new URL('../../public/landingpage.html', import.meta.url)).text()

describe('landing page', () => {
	test('/home drops the signed-in redirect and nothing else', () => {
		expect(landingPage).toContain("fetch('/api/user/info')")
		const home = withoutSignedInRedirect(landingPage)
		expect(home).not.toContain("fetch('/api/user/info')")
		expect(landingPage.length - home.length).toBeLessThan(400)
	})

	test('the live feed escapes everything a record controls', () => {
		const item = landingPage.split('\n').find((line) => line.includes('class="feed-item"'))
		expect(item).toBeDefined()
		// Each interpolation is escaped, or built only from constants and the event time.
		for (const [, expr] of item!.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
			expect(expr).toMatch(
				/^(esc\(|ago\(e\.t\)$|e\.op === 'create' \?|e\.files \? ` · \$\{esc\(e\.files\)\} files` : ''$)/,
			)
		}
		expect(landingPage).toContain(
			'files: Number.isSafeInteger(m.commit.record?.fileCount) ? m.commit.record.fileCount : 0,',
		)
	})
})
