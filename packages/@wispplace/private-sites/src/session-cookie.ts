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
