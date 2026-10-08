/**
 * @wispplace/observability
 * Framework-agnostic observability package with Elysia and Hono middleware
 */

export { CLIENT_CLOSED_REQUEST_STATUS, isClientAbort } from './client-abort'

// Export everything from core
export * from './core'

// Export Grafana integration
export {
	createHostingInstruments,
	createRevalidateQuarantineInstruments,
	type GrafanaConfig,
	grafanaConfig,
	HOSTING_RESPONSE_BUCKETS_MS,
	type HostingInstruments,
	initializeGrafanaExporters,
	type RevalidateQuarantineInstruments,
	shutdownGrafanaExporters,
} from './exporters'

// Note: Middleware should be imported from specific subpaths:
// - import { observabilityMiddleware } from '@wispplace/observability/middleware/elysia'
// - import { observabilityMiddleware, observabilityErrorHandler } from '@wispplace/observability/middleware/hono'
export { redactSecretPath } from './redact'
