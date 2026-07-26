/**
 * Cookie header parsing.
 *
 * The private hosts deliberately do NOT accept main-app's account session cookie: that
 * cookie is host-only to main-app, and owners reach a private site through a single-use
 * handoff token instead. Only the site-scoped session cookie is read here.
 */

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
 * Count how many times a cookie name appears in a raw `Cookie` header.
 *
 * Browsers are the only realistic source of duplicate names, and a duplicate session
 * cookie is exactly what cookie tossing from a sibling subdomain produces. Callers fail
 * closed on any duplicate, which removes parser-ordering (first-wins vs last-wins) from
 * the attack surface entirely.
 */
export const countCookieOccurrences = (header: string | null | undefined, name: string): number => {
	if (!header) return 0
	let count = 0
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq === -1) continue
		if (part.slice(0, eq).trim() === name) count += 1
	}
	return count
}
