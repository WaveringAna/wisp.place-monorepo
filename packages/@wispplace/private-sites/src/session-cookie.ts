/**
 * Verification of the wisp account session cookie.
 *
 * main-app mints the `did` cookie; the hosting service needs to verify it independently so
 * that an owner can view their own private site. Both services read the same
 * `cookie_secrets` row, so this module reimplements exactly the signing scheme Elysia uses
 * (`cookie-signature`): `value + '.' + base64(HMAC-SHA256(value, secret))` with trailing
 * `=` padding stripped.
 *
 * SECURITY: the caller must only trust this cookie on the dedicated private-site host.
 * A session cookie presented to a host that serves user-uploaded content grants nothing,
 * because that content could otherwise read private responses same-origin.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'did'

const signValue = (value: string, secret: string): string =>
	`${value}.${createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '')}`

const constantTimeEqual = (a: string, b: string): boolean => {
	const bufA = Buffer.from(a, 'utf8')
	const bufB = Buffer.from(b, 'utf8')
	if (bufA.length !== bufB.length) return false
	return timingSafeEqual(bufA, bufB)
}

/**
 * Verify a signed cookie value against one or more secrets.
 *
 * Returns the unsigned value, or null when the signature does not verify. Multiple secrets
 * are accepted so a secret rotation does not invalidate live sessions.
 */
export const unsignCookieValue = (signed: string, secrets: readonly string[]): string | null => {
	const dot = signed.lastIndexOf('.')
	if (dot === -1) return null

	const value = signed.slice(0, dot)
	for (const secret of secrets) {
		if (constantTimeEqual(signValue(value, secret), signed)) {
			return value
		}
	}
	return null
}

/** Parse a `Cookie` header into a name/value map. */
export const parseCookieHeader = (header: string | null | undefined): Record<string, string> => {
	const out: Record<string, string> = {}
	if (!header) return out

	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq === -1) continue
		const name = part.slice(0, eq).trim()
		const raw = part.slice(eq + 1).trim()
		if (!name) continue
		try {
			out[name] = decodeURIComponent(raw)
		} catch {
			out[name] = raw
		}
	}
	return out
}

/**
 * Extract a verified account DID from a request's cookie header.
 *
 * Returns null when the cookie is absent, unsigned, tampered with, or not a DID.
 */
export const readSessionDid = (cookieHeader: string | null | undefined, secrets: readonly string[]): string | null => {
	const cookies = parseCookieHeader(cookieHeader)
	const signed = cookies[SESSION_COOKIE_NAME]
	if (!signed) return null

	const value = unsignCookieValue(signed, secrets)
	if (!value?.startsWith('did:')) return null

	return value
}
