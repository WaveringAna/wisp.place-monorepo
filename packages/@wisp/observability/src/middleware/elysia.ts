import type { Context } from 'elysia'
import { metricsCollector, logCollector } from '../core'

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
			(request as any).__startTime = Date.now()
		},
		afterHandle: ({ request, set }: Context) => {
			const startTime = (request as any).__startTime || Date.now()
			const duration = Date.now() - startTime
			const url = new URL(request.url)
			const statusCode = normalizeStatus(set.status, 200)

			metricsCollector.recordRequest(
				url.pathname,
				request.method,
				statusCode,
				duration,
				service
			)
		},
		onError: (context: any) => {
			const { request, error, set } = context as Context & { error: Error }
			const startTime = (request as any).__startTime || Date.now()
			const duration = Date.now() - startTime
			const url = new URL(request.url)
			const statusCode = normalizeStatus(set.status, 500)

			metricsCollector.recordRequest(
				url.pathname,
				request.method,
				statusCode,
				duration,
				service
			)

			// Don't log 404 errors
			if (statusCode !== 404) {
				logCollector.error(
					`Request failed: ${request.method} ${url.pathname}`,
					service,
					error,
					{ statusCode }
				)
			}
		}
	}
}
