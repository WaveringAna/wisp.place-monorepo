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
})
