import type { Context } from 'hono'
import { metricsCollector, logCollector } from '../core'

/**
 * Hono middleware for observability
 * Tracks request metrics
 */
export function observabilityMiddleware(service: string) {
	return async (c: Context, next: () => Promise<void>) => {
		const startTime = Date.now()

		await next()

		const duration = Date.now() - startTime
		const { pathname } = new URL(c.req.url)

		metricsCollector.recordRequest(
			pathname,
			c.req.method,
			c.res.status,
			duration,
			service
		)
	}
}

/**
 * Hono error handler for observability
 * Logs errors with context
 */
export function observabilityErrorHandler(service: string) {
	return (err: Error, c: Context) => {
		const { pathname } = new URL(c.req.url)

		logCollector.error(
			`Request failed: ${c.req.method} ${pathname}`,
			service,
			err,
			{ statusCode: c.res.status || 500 }
		)

		return c.text('Internal Server Error', 500)
	}
}
