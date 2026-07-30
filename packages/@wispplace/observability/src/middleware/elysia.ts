import type { Context } from 'elysia'
import { logCollector, metricsCollector } from '../core'
import { redactSecretPath } from '../redact'

/**
 * Elysia middleware for observability
 * Tracks request metrics and logs errors
 */
export function observabilityMiddleware(service: string) {
	const normalizeStatus = (status: unknown, fallback: number) => {
		if (typeof status === 'number') return status
		if (typeof status === 'string') {
			const parsed = Number(status)
			if (!Number.isNaN(parsed)) return parsed
		}
		return fallback
	}

	return {
		beforeHandle: ({ request }: Context) => {
			// Store start time on request object
			;(request as any).__startTime = Date.now()
		},
		afterHandle: ({ request, route, set }: Context) => {
			const startTime = (request as any).__startTime || Date.now()
			const duration = Date.now() - startTime
			const url = new URL(request.url)
			const statusCode = normalizeStatus(set.status, 200)

			metricsCollector.recordRequest(
				route || redactSecretPath(url.pathname),
				request.method,
				statusCode,
				duration,
				service,
			)
		},
		onError: (context: any) => {
			const { request, error, route, set } = context as Context & { error: Error }
			const startTime = (request as any).__startTime || Date.now()
			const duration = Date.now() - startTime
			const url = new URL(request.url)
			const statusCode = normalizeStatus(set.status, 500)

			metricsCollector.recordRequest(
				route || redactSecretPath(url.pathname),
				request.method,
				statusCode,
				duration,
				service,
			)

			// Don't log 404 errors or expected auth failures
			const isAuthError = error?.message === 'Authentication required'
			if (statusCode !== 404 && !isAuthError) {
				logCollector.error(`Request failed: ${request.method} ${redactSecretPath(url.pathname)}`, service, error, {
					statusCode,
				})
			}
		},
	}
}
