/**
 * @wispplace/observability
 * Framework-agnostic observability package with Elysia and Hono middleware
 */

export { CLIENT_CLOSED_REQUEST_STATUS, isClientAbort } from './client-abort'

// Export everything from core
export * from './core'

// Export Grafana integration
export {
	type GrafanaConfig,
	grafanaConfig,
	initializeGrafanaExporters,
	shutdownGrafanaExporters,
} from './exporters'

// Note: Middleware should be imported from specific subpaths:
// - import { observabilityMiddleware } from '@wispplace/observability/middleware/elysia'
// - import { observabilityMiddleware, observabilityErrorHandler } from '@wispplace/observability/middleware/hono'
export { redactSecretPath } from './redact'
