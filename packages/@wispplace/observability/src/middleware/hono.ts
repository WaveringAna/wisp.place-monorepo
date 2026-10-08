import type { Context } from 'hono'
import { routePath } from 'hono/route'
import { CLIENT_CLOSED_REQUEST_STATUS, isClientAbort } from '../client-abort'
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
 * Logs errors with context; a client that went away is not a server error.
 */
export function observabilityErrorHandler(service: string) {
	return (err: Error, c: Context) => {
		const route = `${c.req.method} ${redactSecretPath(new URL(c.req.url).pathname)}`

		if (isClientAbort(err, c.req.raw.signal)) {
			logCollector.info(`Request aborted by client: ${route}`, service, { errorName: err.name })
			return new Response(null, { status: CLIENT_CLOSED_REQUEST_STATUS })
		}

		logCollector.error(`Request failed: ${route}`, service, err, {
			statusCode: c.res.status || 500,
		})

		return c.text('Internal Server Error', 500)
	}
}
