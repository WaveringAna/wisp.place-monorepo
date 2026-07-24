import { describe, expect, it } from 'bun:test'
import { readSessionDid, unsignCookieValue } from '@wispplace/private-sites'
import { signCookie } from 'elysia/utils'

/**
 * The hosting service verifies the session cookie that main-app mints, using its own
 * reimplementation of the signing scheme in `@wispplace/private-sites`. If Elysia ever
 * changes how it signs cookies, owner access to private sites would silently break.
 *
 * This test pins the two implementations together against the real Elysia function.
 */
describe('session cookie compatibility with elysia', () => {
	const SECRET = 'compat-test-secret'
	const DID = 'did:plc:owneraaaaaaaaaaaaaaaaaaaa'

	it('verifies a cookie actually signed by elysia', async () => {
		const signed = await signCookie(DID, SECRET)
		expect(unsignCookieValue(signed, [SECRET])).toBe(DID)
	})

	it('reads the DID out of a real elysia-signed cookie header', async () => {
		const signed = await signCookie(DID, SECRET)
		expect(readSessionDid(`did=${encodeURIComponent(signed)}`, [SECRET])).toBe(DID)
	})

	it('rejects an elysia cookie signed with a different secret', async () => {
		const signed = await signCookie(DID, 'a-different-secret')
		expect(unsignCookieValue(signed, [SECRET])).toBeNull()
	})

	it('matches elysia byte for byte across several inputs', async () => {
		for (const [value, secret] of [
			[DID, SECRET],
			['did:web:example.com', 'k'],
			['did:plc:zzzzzzzzzzzzzzzzzzzzzzzz', 'another-secret'],
		] as const) {
			const signed = await signCookie(value, secret)
			expect(unsignCookieValue(signed, [secret])).toBe(value)
		}
	})
})
