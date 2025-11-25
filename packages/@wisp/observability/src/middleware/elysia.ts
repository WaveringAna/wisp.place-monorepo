import { metricsCollector, logCollector } from '../core'

/**
 * Elysia middleware for observability
 * Tracks request metrics and logs errors
 */
export function observabilityMiddleware(service: string) {
	return {
		beforeHandle: ({ request }: any) => {
			// Store start time on request object
			(request as any).__startTime = Date.now()
		},
		afterHandle: ({ request, set }: any) => {
			const duration = Date.now() - ((request as any).__startTime || Date.now())
			const url = new URL(request.url)

			metricsCollector.recordRequest(
				url.pathname,
				request.method,
				set.status || 200,
				duration,
				service
			)
		},
		onError: ({ request, error, set }: any) => {
			const duration = Date.now() - ((request as any).__startTime || Date.now())
			const url = new URL(request.url)

			metricsCollector.recordRequest(
				url.pathname,
				request.method,
				set.status || 500,
				duration,
				service
			)

			// Don't log 404 errors
			const statusCode = set.status || 500
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
