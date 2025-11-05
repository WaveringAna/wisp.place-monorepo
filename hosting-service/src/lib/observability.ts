// DIY Observability for Hosting Service
import type { Context } from 'hono'

// Types
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

// In-memory storage with rotation
const MAX_LOGS = 5000
const MAX_ERRORS = 500
const MAX_METRICS = 10000

const logs: LogEntry[] = []
const errors: Map<string, ErrorEntry> = new Map()
const metrics: MetricEntry[] = []

// Helper to generate unique IDs
let logCounter = 0
let errorCounter = 0

function generateId(prefix: string, counter: number): string {
	return `${prefix}-${Date.now()}-${counter}`
}

// Helper to extract event type from message
function extractEventType(message: string): string | undefined {
	const match = message.match(/^\[([^\]]+)\]/)
	return match ? match[1] : undefined
}

// Log collector
export const logCollector = {
	log(level: LogEntry['level'], message: string, service: string, context?: Record<string, any>, traceId?: string) {
		const entry: LogEntry = {
			id: generateId('log', logCounter++),
			timestamp: new Date(),
			level,
			message,
			service,
			context,
			traceId,
			eventType: extractEventType(message)
		}

		logs.unshift(entry)

		// Rotate if needed
		if (logs.length > MAX_LOGS) {
			logs.splice(MAX_LOGS)
		}

		// Also log to console for compatibility
		const contextStr = context ? ` ${JSON.stringify(context)}` : ''
		const traceStr = traceId ? ` [trace:${traceId}]` : ''
		console[level === 'debug' ? 'log' : level](`[${service}] ${message}${contextStr}${traceStr}`)
	},

	info(message: string, service: string, context?: Record<string, any>, traceId?: string) {
		this.log('info', message, service, context, traceId)
	},

	warn(message: string, service: string, context?: Record<string, any>, traceId?: string) {
		this.log('warn', message, service, context, traceId)
	},

	error(message: string, service: string, error?: any, context?: Record<string, any>, traceId?: string) {
		const ctx = { ...context }
		if (error instanceof Error) {
			ctx.error = error.message
			ctx.stack = error.stack
		} else if (error) {
			ctx.error = String(error)
		}
		this.log('error', message, service, ctx, traceId)

		// Also track in errors
		errorTracker.track(message, service, error, context)
	},

	debug(message: string, service: string, context?: Record<string, any>, traceId?: string) {
		if (process.env.NODE_ENV !== 'production') {
			this.log('debug', message, service, context, traceId)
		}
	},

	getLogs(filter?: { level?: string; service?: string; limit?: number; search?: string; eventType?: string }) {
		let filtered = [...logs]

		if (filter?.level) {
			filtered = filtered.filter(log => log.level === filter.level)
		}

		if (filter?.service) {
			filtered = filtered.filter(log => log.service === filter.service)
		}

		if (filter?.eventType) {
			filtered = filtered.filter(log => log.eventType === filter.eventType)
		}

		if (filter?.search) {
			const search = filter.search.toLowerCase()
			filtered = filtered.filter(log =>
				log.message.toLowerCase().includes(search) ||
				JSON.stringify(log.context).toLowerCase().includes(search)
			)
		}

		const limit = filter?.limit || 100
		return filtered.slice(0, limit)
	},

	clear() {
		logs.length = 0
	}
}

// Error tracker with deduplication
export const errorTracker = {
	track(message: string, service: string, error?: any, context?: Record<string, any>) {
		const key = `${service}:${message}`

		const existing = errors.get(key)
		if (existing) {
			existing.count++
			existing.lastSeen = new Date()
			if (context) {
				existing.context = { ...existing.context, ...context }
			}
		} else {
			const entry: ErrorEntry = {
				id: generateId('error', errorCounter++),
				timestamp: new Date(),
				message,
				service,
				context,
				count: 1,
				lastSeen: new Date()
			}

			if (error instanceof Error) {
				entry.stack = error.stack
			}

			errors.set(key, entry)

			// Rotate if needed
			if (errors.size > MAX_ERRORS) {
				const oldest = Array.from(errors.keys())[0]
				if (oldest !== undefined) {
					errors.delete(oldest)
				}
			}
		}
	},

	getErrors(filter?: { service?: string; limit?: number }) {
		let filtered = Array.from(errors.values())

		if (filter?.service) {
			filtered = filtered.filter(err => err.service === filter.service)
		}

		// Sort by last seen (most recent first)
		filtered.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())

		const limit = filter?.limit || 100
		return filtered.slice(0, limit)
	},

	clear() {
		errors.clear()
	}
}

// Metrics collector
export const metricsCollector = {
	recordRequest(path: string, method: string, statusCode: number, duration: number, service: string) {
		const entry: MetricEntry = {
			timestamp: new Date(),
			path,
			method,
			statusCode,
			duration,
			service
		}

		metrics.unshift(entry)

		// Rotate if needed
		if (metrics.length > MAX_METRICS) {
			metrics.splice(MAX_METRICS)
		}
	},

	getMetrics(filter?: { service?: string; timeWindow?: number }) {
		let filtered = [...metrics]

		if (filter?.service) {
			filtered = filtered.filter(m => m.service === filter.service)
		}

		if (filter?.timeWindow) {
			const cutoff = Date.now() - filter.timeWindow
			filtered = filtered.filter(m => m.timestamp.getTime() > cutoff)
		}

		return filtered
	},

	getStats(service?: string, timeWindow: number = 3600000) {
		const filtered = this.getMetrics({ service, timeWindow })

		if (filtered.length === 0) {
			return {
				totalRequests: 0,
				avgDuration: 0,
				p50Duration: 0,
				p95Duration: 0,
				p99Duration: 0,
				errorRate: 0,
				requestsPerMinute: 0
			}
		}

		const durations = filtered.map(m => m.duration).sort((a, b) => a - b)
		const totalDuration = durations.reduce((sum, d) => sum + d, 0)
		const errors = filtered.filter(m => m.statusCode >= 400).length

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
			requestsPerMinute: Math.round(filtered.length / timeWindowMinutes)
		}
	},

	clear() {
		metrics.length = 0
	}
}

// Hono middleware for request timing
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

// Hono error handler
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

// Export singleton logger for easy access
export const logger = {
	info: (message: string, context?: Record<string, any>) =>
		logCollector.info(message, 'hosting-service', context),
	warn: (message: string, context?: Record<string, any>) =>
		logCollector.warn(message, 'hosting-service', context),
	error: (message: string, error?: any, context?: Record<string, any>) =>
		logCollector.error(message, 'hosting-service', error, context),
	debug: (message: string, context?: Record<string, any>) =>
		logCollector.debug(message, 'hosting-service', context)
}
