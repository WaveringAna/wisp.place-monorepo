import { Elysia } from 'elysia'
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

		return allowedHosts.some(host => originHost === host)
	} catch {
		// Invalid URL
		return false
	}
}

/**
 * CSRF Protection Middleware for Elysia
 *
 * Validates Origin header against Host header for non-GET requests
 * to prevent CSRF attacks when using cookie-based authentication.
 *
 * Usage:
 * ```ts
 * import { csrfProtection } from './lib/csrf'
 *
 * new Elysia()
 *   .use(csrfProtection())
 *   .post('/api/protected', handler)
 * ```
 */
export const csrfProtection = () => {
	return new Elysia({ name: 'csrf-protection' })
		.onBeforeHandle(({ request, set }) => {
			const method = request.method.toUpperCase()

			// Only protect state-changing methods
			if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
				return
			}

			// Get headers
			const originHeader = request.headers.get('Origin')
			// Use X-Forwarded-Host if behind a proxy, otherwise use Host
			const hostHeader = request.headers.get('X-Forwarded-Host') || request.headers.get('Host')

			// Validate origin matches host
			if (!originHeader || !hostHeader || !verifyRequestOrigin(originHeader, [hostHeader])) {
				logger.warn('[CSRF] Request blocked', {
					method,
					origin: originHeader,
					host: hostHeader,
					path: new URL(request.url).pathname
				})

				set.status = 403
				return {
					error: 'CSRF validation failed',
					message: 'Request origin does not match host'
				}
			}
		})
}
