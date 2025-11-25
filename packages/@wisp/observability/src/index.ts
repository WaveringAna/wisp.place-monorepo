/**
 * @wisp/observability
 * Framework-agnostic observability package with Elysia and Hono middleware
 */

// Export everything from core
export * from './core'

// Note: Middleware should be imported from specific subpaths:
// - import { observabilityMiddleware } from '@wisp/observability/middleware/elysia'
// - import { observabilityMiddleware, observabilityErrorHandler } from '@wisp/observability/middleware/hono'
