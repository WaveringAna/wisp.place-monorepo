/**
 * Core observability types and collectors
 * Framework-agnostic logging, error tracking, and metrics collection
 */

import { lokiExporter, metricsExporter } from './exporters'
import { sanitizeContext, sanitizeError, sanitizeForLog, sanitizeLogString } from './redact'

// ============================================================================
// Types
// ============================================================================

export interface LogEntry {
	id: string
	timestamp: Date
	level: 'info' | 'warn' | 'error' | 'debug'
	message: string
	service: string
	context?: Record<string, any>
	traceId?: string
	eventType?: string
}

export interface ErrorEntry {
	id: string
	timestamp: Date
	message: string
	stack?: string
	service: string
	context?: Record<string, any>
	count: number
	lastSeen: Date
}

export interface MetricEntry {
	timestamp: Date
	path: string
	method: string
	statusCode: number
	duration: number
	service: string
}

export interface LogFilter {
	level?: string
	service?: string
	limit?: number
	search?: string
	eventType?: string
}

export interface ErrorFilter {
	service?: string
	limit?: number
}

export interface MetricFilter {
	service?: string
	timeWindow?: number
}

export interface MetricStats {
	totalRequests: number
	avgDuration: number
	p50Duration: number
	p95Duration: number
	p99Duration: number
	errorRate: number
	requestsPerMinute: number
}

// ============================================================================
// Configuration
// ============================================================================

const MAX_LOGS = 5000
const MAX_ERRORS = 500
const MAX_METRICS = 10000

// ============================================================================
// Storage
// ============================================================================

const logs: LogEntry[] = []
const errors: Map<string, ErrorEntry> = new Map()
const metrics: MetricEntry[] = []

// ============================================================================
// Helpers
// ============================================================================

let logCounter = 0
let errorCounter = 0

function generateId(prefix: string, counter: number): string {
	return `${prefix}-${Date.now()}-${counter}`
}

function extractEventType(message: string): string | undefined {
	const match = message.match(/^\[([^\]]+)\]/)
	return match ? match[1] : undefined
}

// ============================================================================
// Helpers
// ============================================================================

function serializeContext(context: Record<string, any>): string {
	try {
		return JSON.stringify(context)
	} catch {
		return '{"context":"<unserializable>"}'
	}
}

// ============================================================================
// Log Collector
// ============================================================================

export const logCollector = {
	log(level: LogEntry['level'], message: string, service: string, context?: Record<string, any>, traceId?: string) {
		const safeMessage = sanitizeLogString(message)
		const safeService = sanitizeLogString(service)
		const safeContext = sanitizeContext(context)
		const safeTraceId = traceId === undefined ? undefined : sanitizeLogString(traceId)
		const entry: LogEntry = {
			id: generateId('log', logCounter++),
			timestamp: new Date(),
			level,
			message: safeMessage,
			service: safeService,
			context: safeContext,
			traceId: safeTraceId,
			eventType: extractEventType(safeMessage),
		}

		logs.unshift(entry)

		// Rotate if needed
		if (logs.length > MAX_LOGS) {
			logs.splice(MAX_LOGS)
		}

		// Send only the sanitized entry to Loki.
		lokiExporter.pushLog(entry)

		// Also log only sanitized JSON to console for compatibility.
		const contextStr = safeContext ? ` ${serializeContext(safeContext)}` : ''
		const traceStr = safeTraceId ? ` [trace:${safeTraceId}]` : ''
		console[level === 'debug' ? 'log' : level](`[${safeService}] ${safeMessage}${contextStr}${traceStr}`)
	},

	info(message: string, service: string, context?: Record<string, any>, traceId?: string) {
		this.log('info', message, service, context, traceId)
	},

	warn(message: string, service: string, context?: Record<string, any>, traceId?: string) {
		this.log('warn', message, service, context, traceId)
	},

	error(message: string, service: string, error?: unknown, context?: Record<string, any>, traceId?: string) {
		const ctx = sanitizeContext(context) ?? {}
		const safeError = sanitizeError(error)

		if (safeError) {
			ctx.error = safeError.message
			ctx.errorName = safeError.name
			if (safeError.stack) ctx.stack = safeError.stack
		} else if (error !== undefined) {
			ctx.error = sanitizeForLog(error)
		}

		this.log('error', message, service, ctx, traceId)

		// Also track in errors. errorTracker repeats sanitization for direct callers.
		errorTracker.track(message, service, error, context)
	},

	debug(message: string, service: string, context?: Record<string, any>, traceId?: string) {
		if (process.env.NODE_ENV !== 'production') {
			this.log('debug', message, service, context, traceId)
		}
	},

	getLogs(filter?: LogFilter) {
		let filtered = [...logs]

		if (filter?.level) {
			filtered = filtered.filter((log) => log.level === filter.level)
		}

		if (filter?.service) {
			filtered = filtered.filter((log) => log.service === filter.service)
		}

		if (filter?.eventType) {
			filtered = filtered.filter((log) => log.eventType === filter.eventType)
		}

		if (filter?.search) {
			const search = filter.search.toLowerCase()
			filtered = filtered.filter(
				(log) =>
					log.message.toLowerCase().includes(search) ||
					(log.context ? serializeContext(log.context).toLowerCase().includes(search) : false),
			)
		}

		const limit = filter?.limit || 100
		return filtered.slice(0, limit)
	},

	clear() {
		logs.length = 0
	},
}

// ============================================================================
// Error Tracker
// ============================================================================

export const errorTracker = {
	track(message: string, service: string, error?: unknown, context?: Record<string, any>) {
		const safeMessage = sanitizeLogString(message)
		const safeService = sanitizeLogString(service)
		const safeContext = sanitizeContext(context)
		const safeError = sanitizeError(error)
		const safeErrorValue = safeError
			? { name: safeError.name, message: safeError.message }
			: error === undefined
				? undefined
				: sanitizeForLog(error)
		const trackedContext =
			safeErrorValue === undefined ? safeContext : { ...(safeContext ?? {}), error: safeErrorValue }
		const key = `${safeService}:${safeMessage}`

		const existing = errors.get(key)
		if (existing) {
			existing.count++
			existing.lastSeen = new Date()
			if (trackedContext) {
				existing.context = { ...existing.context, ...trackedContext }
			}
			if (safeError?.stack) existing.stack = safeError.stack
		} else {
			const entry: ErrorEntry = {
				id: generateId('error', errorCounter++),
				timestamp: new Date(),
				message: safeMessage,
				service: safeService,
				context: trackedContext,
				count: 1,
				lastSeen: new Date(),
			}

			if (safeError?.stack) {
				entry.stack = safeError.stack
			}

			errors.set(key, entry)

			// Send only the sanitized entry to Loki.
			lokiExporter.pushError(entry)

			// Rotate if needed
			if (errors.size > MAX_ERRORS) {
				const oldest = Array.from(errors.keys())[0]
				if (oldest !== undefined) {
					errors.delete(oldest)
				}
			}
		}
	},

	getErrors(filter?: ErrorFilter) {
		let filtered = Array.from(errors.values())

		if (filter?.service) {
			filtered = filtered.filter((err) => err.service === filter.service)
		}

		// Sort by last seen (most recent first)
		filtered.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())

		const limit = filter?.limit || 100
		return filtered.slice(0, limit)
	},

	clear() {
		errors.clear()
	},
}

// ============================================================================
// Metrics Collector
// ============================================================================

export const metricsCollector = {
	recordRequest(path: string, method: string, statusCode: number, duration: number, service: string) {
		const entry: MetricEntry = {
			timestamp: new Date(),
			path: sanitizeLogString(path),
			method: sanitizeLogString(method),
			statusCode,
			duration,
			service: sanitizeLogString(service),
		}

		metrics.unshift(entry)

		// Send to Prometheus/OTLP exporter
		metricsExporter.recordMetric(entry)

		// Rotate if needed
		if (metrics.length > MAX_METRICS) {
			metrics.splice(MAX_METRICS)
		}
	},

	getMetrics(filter?: MetricFilter) {
		let filtered = [...metrics]

		if (filter?.service) {
			filtered = filtered.filter((m) => m.service === filter.service)
		}

		if (filter?.timeWindow) {
			const cutoff = Date.now() - filter.timeWindow
			filtered = filtered.filter((m) => m.timestamp.getTime() > cutoff)
		}

		return filtered
	},

	getStats(service?: string, timeWindow: number = 3600000): MetricStats {
		const filtered = this.getMetrics({ service, timeWindow })

		if (filtered.length === 0) {
			return {
				totalRequests: 0,
				avgDuration: 0,
				p50Duration: 0,
				p95Duration: 0,
				p99Duration: 0,
				errorRate: 0,
				requestsPerMinute: 0,
			}
		}

		const durations = filtered.map((m) => m.duration).sort((a, b) => a - b)
		const totalDuration = durations.reduce((sum, d) => sum + d, 0)
		const errors = filtered.filter((m) => m.statusCode >= 400).length

		const p50 = durations[Math.floor(durations.length * 0.5)]
		const p95 = durations[Math.floor(durations.length * 0.95)]
		const p99 = durations[Math.floor(durations.length * 0.99)]

		const timeWindowMinutes = timeWindow / 60000

		return {
			totalRequests: filtered.length,
			avgDuration: Math.round(totalDuration / filtered.length),
			p50Duration: Math.round(p50 ?? 0),
			p95Duration: Math.round(p95 ?? 0),
			p99Duration: Math.round(p99 ?? 0),
			errorRate: (errors / filtered.length) * 100,
			requestsPerMinute: Math.round(filtered.length / timeWindowMinutes),
		}
	},

	clear() {
		metrics.length = 0
	},
}

// ============================================================================
// Logger Factory
// ============================================================================

/**
 * Create a service-specific logger instance
 */
export function createLogger(service: string) {
	return {
		info: (message: string, context?: Record<string, any>) => logCollector.info(message, service, context),
		warn: (message: string, context?: Record<string, any>) => logCollector.warn(message, service, context),
		error: (message: string, error?: any, context?: Record<string, any>) =>
			logCollector.error(message, service, error, context),
		debug: (message: string, context?: Record<string, any>) => logCollector.debug(message, service, context),
	}
}
