import type { Context } from 'hono'
import { routePath } from 'hono/route'
import { logCollector, metricsCollector } from '../core'
import { redactSecretPath } from '../redact'

/**
 * Hono middleware for observability
 * Tracks request metrics
 */
export function observabilityMiddleware(service: string) {
	return async (c: Context, next: () => Promise<void>) => {
		const startTime = Date.now()

		await next()

		const duration = Date.now() - startTime
		const pathname = routePath(c) || new URL(c.req.url).pathname

		metricsCollector.recordRequest(pathname, c.req.method, c.res.status, duration, service)
	}
}

/**
 * Hono error handler for observability
 * Logs errors with context
 */
export function observabilityErrorHandler(service: string) {
	return (err: Error, c: Context) => {
		const { pathname } = new URL(c.req.url)

		logCollector.error(`Request failed: ${c.req.method} ${redactSecretPath(pathname)}`, service, err, {
			statusCode: c.res.status || 500,
		})

		return c.text('Internal Server Error', 500)
	}
}
