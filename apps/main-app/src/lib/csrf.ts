import { logger } from './logger'

/**
 * CSRF Protection using Origin/Host header verification
 * Based on Lucia's recommended approach for cookie-based authentication
 *
 * This validates that the Origin header matches the Host header for
 * state-changing requests (POST, PUT, DELETE, PATCH).
 */

/**
 * Verify that the request origin matches the expected host
 * @param origin - The Origin header value
 * @param allowedHosts - Array of allowed host values
 * @returns true if origin is valid, false otherwise
 */
export function verifyRequestOrigin(origin: string, allowedHosts: string[]): boolean {
	if (!origin) {
		return false
	}

	try {
		const originUrl = new URL(origin)
		const originHost = originUrl.host

		return allowedHosts.some((host) => originHost === host || (host.startsWith('.') && originHost.endsWith(host)))
	} catch {
		// Invalid URL
		return false
	}
}

/**
 * CSRF Protection Middleware for Elysia
 *
 * NOTE: apply via `.onBeforeHandle(csrfProtection(...))` directly on the root
 * app instance, NOT wrapped in a `new Elysia({ name })` plugin. In Elysia
 * 1.4.x, lifecycle hooks from a named plugin `.use()`'d before route modules do
 * not propagate to those routes, leaving CSRF silently unenforced. Applying the
 * hook directly on the root instance propagates to all child `.use()` routes.
 *
 * `allowedExtraOrigins` permits additional exact hosts (e.g. the private-site
 * origin that legitimately POSTs /private/redeem). Entries beginning with `.`
 * match any subdomain of that suffix, so `<siteId>.priv.<host>` is covered.
 *
 * Usage:
 * ```ts
 * import { csrfProtection } from './lib/csrf'
 *
 * new Elysia()
 *   .onBeforeHandle(csrfProtection(['.priv.example.com']))
 *   .post('/api/protected', handler)
 * ```
 */
export const csrfProtection =
	(allowedExtraOrigins: string[] = []) =>
	({ request, set }: { request: Request; set: { status?: number | string } }) => {
		const method = request.method.toUpperCase()

		// Only protect state-changing methods
		if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
			return
		}

		// Get headers
		const originHeader = request.headers.get('Origin')
		// Use X-Forwarded-Host if behind a proxy, otherwise use Host
		const hostHeader = request.headers.get('X-Forwarded-Host') || request.headers.get('Host')

		// Validate origin matches host or an explicitly allowlisted origin
		if (!originHeader || !hostHeader || !verifyRequestOrigin(originHeader, [hostHeader, ...allowedExtraOrigins])) {
			logger.warn('[CSRF] Request blocked', {
				method,
				origin: originHeader,
				host: hostHeader,
				path: new URL(request.url).pathname,
			})

			set.status = 403
			return {
				error: 'CSRF validation failed',
				message: 'Request origin does not match host',
			}
		}
	}
