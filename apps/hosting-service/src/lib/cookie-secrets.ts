/**
 * Access to the shared cookie signing secret.
 *
 * main-app mints the account session cookie and stores its signing secret in
 * `cookie_secrets`. The hosting service reads the same row so it can verify an owner's
 * session on the private host without calling back into main-app.
 *
 * The secret is cached in memory with a short TTL so a rotation is picked up without a
 * redeploy, and so a database hiccup does not immediately log every owner out.
 */

import { createLogger } from '@wispplace/observability'
import postgres from 'postgres'

const logger = createLogger('hosting-service')

const sql = postgres(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/wisp', {
	max: 2,
	idle_timeout: 20,
})

const CACHE_TTL_MS = 60_000

let cached: { secrets: string[]; fetchedAt: number } | null = null

/**
 * Current cookie signing secrets, newest first.
 *
 * Returns an empty array when no secret is available, which makes session verification
 * fail closed: owners fall back to needing a share link rather than access being granted
 * on an unverified cookie.
 */
export const getCookieSecrets = async (): Promise<string[]> => {
	const now = Date.now()
	if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
		return cached.secrets
	}

	try {
		const rows = await sql<Array<{ secret: string }>>`
      SELECT secret FROM cookie_secrets WHERE id = 'default' LIMIT 1
    `
		const secrets = rows.map((r) => r.secret).filter((s): s is string => typeof s === 'string' && s.length > 0)
		cached = { secrets, fetchedAt: now }
		return secrets
	} catch (err) {
		logger.warn('[PrivateSite] Failed to load cookie secret; owner sessions will not verify', { error: err })
		// Serve the previous value if we have one; otherwise fail closed.
		return cached?.secrets ?? []
	}
}
