/**
 * Grafana exporters for logs and metrics
 * Integrates with Grafana Loki for logs and Prometheus/OTLP for metrics
 */

import os from 'node:os'
import { gzipSync } from 'node:zlib'
import { type Counter, type Histogram, type MeterProvider, metrics, type ObservableGauge } from '@opentelemetry/api'
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPMetricExporter as OTLPMetricExporterProto } from '@opentelemetry/exporter-metrics-otlp-proto'
import type { CompressionAlgorithm } from '@opentelemetry/otlp-exporter-base'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { PeriodicExportingMetricReader, MeterProvider as SdkMeterProvider } from '@opentelemetry/sdk-metrics'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import type { ErrorEntry, LogEntry, MetricEntry } from './core'
import { sanitizeContext, sanitizeForLog, sanitizeLogString } from './redact'

// ============================================================================
// Types
// ============================================================================

export interface GrafanaConfig {
	lokiUrl?: string
	lokiAuth?: {
		username?: string
		password?: string
		bearerToken?: string
	}
	prometheusUrl?: string
	prometheusAuth?: {
		username?: string
		password?: string
		bearerToken?: string
	}
	prometheusEncoding?: 'protobuf' | 'json'
	serviceName?: string
	serviceVersion?: string
	batchSize?: number
	flushIntervalMs?: number
	enabled?: boolean
}

interface LokiStream {
	stream: Record<string, string>
	values: Array<[string, string]>
}

interface LokiBatch {
	streams: LokiStream[]
}

function serviceInstance(serviceName: string): string {
	return `${serviceName}-${os.hostname()}`
}

function sanitizeLogEntry(entry: LogEntry): LogEntry {
	return {
		...entry,
		id: sanitizeLogString(entry.id),
		message: sanitizeLogString(entry.message),
		service: sanitizeLogString(entry.service),
		context: sanitizeContext(entry.context),
		traceId: entry.traceId === undefined ? undefined : sanitizeLogString(entry.traceId),
		eventType: entry.eventType === undefined ? undefined : sanitizeLogString(entry.eventType),
	}
}

function sanitizeErrorEntry(entry: ErrorEntry): ErrorEntry {
	return {
		...entry,
		id: sanitizeLogString(entry.id),
		message: sanitizeLogString(entry.message),
		stack: entry.stack === undefined ? undefined : sanitizeLogString(entry.stack),
		service: sanitizeLogString(entry.service),
		context: sanitizeContext(entry.context),
	}
}

// ============================================================================
// Configuration
// ============================================================================

class GrafanaExporterConfig {
	private config: GrafanaConfig = {
		enabled: false,
		batchSize: 100,
		flushIntervalMs: 5000,
		serviceName: 'wisp-app',
		serviceVersion: '1.0.0',
	}

	initialize(config: GrafanaConfig) {
		this.config = { ...this.config, ...config }

		// Load from environment variables if not provided
		if (!this.config.lokiUrl) {
			this.config.lokiUrl = process.env.GRAFANA_LOKI_URL
		}

		if (!this.config.prometheusUrl) {
			this.config.prometheusUrl = process.env.GRAFANA_PROMETHEUS_URL
		}

		// Load Loki authentication from environment
		if (!this.config.lokiAuth?.bearerToken && !this.config.lokiAuth?.username) {
			const token = process.env.GRAFANA_LOKI_TOKEN
			const username = process.env.GRAFANA_LOKI_USERNAME
			const password = process.env.GRAFANA_LOKI_PASSWORD

			if (token) {
				this.config.lokiAuth = { ...this.config.lokiAuth, bearerToken: token }
			} else if (username && password) {
				this.config.lokiAuth = { ...this.config.lokiAuth, username, password }
			}
		}

		// Load Prometheus authentication from environment
		if (!this.config.prometheusAuth?.bearerToken && !this.config.prometheusAuth?.username) {
			const token = process.env.GRAFANA_PROMETHEUS_TOKEN
			const username = process.env.GRAFANA_PROMETHEUS_USERNAME
			const password = process.env.GRAFANA_PROMETHEUS_PASSWORD

			if (token) {
				this.config.prometheusAuth = { ...this.config.prometheusAuth, bearerToken: token }
			} else if (username && password) {
				this.config.prometheusAuth = { ...this.config.prometheusAuth, username, password }
			}
		}

		// Enable if URLs are configured
		if (this.config.lokiUrl || this.config.prometheusUrl) {
			this.config.enabled = true
		}

		return this
	}

	getConfig(): GrafanaConfig {
		return { ...this.config }
	}

	isEnabled(): boolean {
		return this.config.enabled === true
	}
}

export const grafanaConfig = new GrafanaExporterConfig()

// ============================================================================
// Loki Exporter for Logs
// ============================================================================

class LokiExporter {
	private buffer: LogEntry[] = []
	private errorBuffer: ErrorEntry[] = []
	private flushTimer?: NodeJS.Timeout
	private flushPromise: Promise<void> = Promise.resolve()
	private stopPromise?: Promise<void>
	private config: GrafanaConfig = {}
	private instance = serviceInstance('wisp-app')

	initialize(config: GrafanaConfig) {
		if (this.flushTimer) {
			clearInterval(this.flushTimer)
			this.flushTimer = undefined
		}

		this.config = config
		this.instance = serviceInstance(config.serviceName || 'wisp-app')
		this.stopPromise = undefined

		if (this.config.enabled && this.config.lokiUrl) {
			this.startBatching()
		}
	}

	private startBatching() {
		const interval = this.config.flushIntervalMs || 5000

		this.flushTimer = setInterval(() => {
			void this.flush()
		}, interval)
	}

	async stop(): Promise<void> {
		if (this.stopPromise) return this.stopPromise

		if (this.flushTimer) {
			clearInterval(this.flushTimer)
			this.flushTimer = undefined
		}

		const stopPromise = this.flush()
		this.stopPromise = stopPromise
		try {
			await stopPromise
		} finally {
			if (this.stopPromise === stopPromise) this.stopPromise = undefined
		}
	}

	pushLog(entry: LogEntry) {
		if (!this.config.enabled || !this.config.lokiUrl) return

		this.buffer.push(sanitizeLogEntry(entry))

		const batchSize = this.config.batchSize || 100
		if (this.buffer.length >= batchSize) {
			void this.flush()
		}
	}

	pushError(entry: ErrorEntry) {
		if (!this.config.enabled || !this.config.lokiUrl) return

		this.errorBuffer.push(sanitizeErrorEntry(entry))

		const batchSize = this.config.batchSize || 100
		if (this.errorBuffer.length >= batchSize) {
			void this.flush()
		}
	}

	private flush(): Promise<void> {
		const run = () => this.flushBuffer()
		this.flushPromise = this.flushPromise.then(run, run)
		return this.flushPromise
	}

	private async flushBuffer(): Promise<void> {
		if (!this.config.lokiUrl) return

		const logsToSend = [...this.buffer]
		const errorsToSend = [...this.errorBuffer]

		this.buffer = []
		this.errorBuffer = []

		if (logsToSend.length === 0 && errorsToSend.length === 0) return

		try {
			const batch = this.createLokiBatch(logsToSend, errorsToSend)
			await this.sendToLoki(batch)
		} catch (error) {
			console.error('[LokiExporter] Failed to send logs to Loki:', sanitizeForLog(error))
			// Optionally re-queue failed logs
		}
	}

	private createLokiBatch(logs: LogEntry[], errors: ErrorEntry[]): LokiBatch {
		const streams: LokiStream[] = []

		// Group logs by service and level
		const logGroups = new Map<string, LogEntry[]>()

		for (const log of logs) {
			const key = `${log.service}-${log.level}`
			const group = logGroups.get(key) || []
			group.push(log)
			logGroups.set(key, group)
		}

		// Create streams for logs
		for (const [key, entries] of logGroups) {
			const [service, level] = key.split('-')
			const values: Array<[string, string]> = entries.map((entry) => {
				const logLine = JSON.stringify({
					_msg: entry.message,
					message: entry.message,
					context: entry.context,
					traceId: entry.traceId,
					eventType: entry.eventType,
				})

				// Loki expects nanosecond timestamp as string
				const nanoTimestamp = String(entry.timestamp.getTime() * 1000000)
				return [nanoTimestamp, logLine]
			})

			streams.push({
				stream: {
					service: service || 'unknown',
					level: level || 'info',
					job: this.config.serviceName || 'wisp-app',
					instance: this.instance,
				},
				values,
			})
		}

		// Group errors by service (similar to logs)
		const errorGroups = new Map<string, ErrorEntry[]>()
		for (const error of errors) {
			const service = error.service
			const group = errorGroups.get(service) || []
			group.push(error)
			errorGroups.set(service, group)
		}

		// Create streams for errors (one per service)
		for (const [service, entries] of errorGroups) {
			const errorValues: Array<[string, string]> = entries.map((entry) => {
				const logLine = JSON.stringify({
					_msg: entry.message,
					message: entry.message,
					stack: entry.stack,
					context: entry.context,
					count: entry.count,
				})

				const nanoTimestamp = String(entry.timestamp.getTime() * 1000000)
				return [nanoTimestamp, logLine]
			})

			streams.push({
				stream: {
					service: service,
					level: 'error',
					job: this.config.serviceName || 'wisp-app',
					instance: this.instance,
					type: 'aggregated_error',
				},
				values: errorValues,
			})
		}

		return { streams }
	}

	private async sendToLoki(batch: LokiBatch) {
		if (!this.config.lokiUrl) return

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Content-Encoding': 'gzip',
		}

		// Add authentication
		if (this.config.lokiAuth?.bearerToken) {
			headers.Authorization = `Bearer ${this.config.lokiAuth.bearerToken}`
		} else if (this.config.lokiAuth?.username && this.config.lokiAuth?.password) {
			const auth = Buffer.from(`${this.config.lokiAuth.username}:${this.config.lokiAuth.password}`).toString('base64')
			headers.Authorization = `Basic ${auth}`
		}

		// Gzip compress the payload
		const jsonPayload = JSON.stringify(batch)
		const compressedPayload = gzipSync(jsonPayload)

		const lokiPath = process.env.GRAFANA_LOKI_PATH || '/loki/api/v1/push'
		const response = await fetch(`${this.config.lokiUrl}${lokiPath}`, {
			method: 'POST',
			headers,
			body: compressedPayload,
		})

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Loki push failed: ${response.status} - ${text}`)
		}
	}
}

// ============================================================================
// OpenTelemetry Metrics Exporter
// ============================================================================

class MetricsExporter {
	private meterProvider?: MeterProvider
	private requestCounter?: Counter
	private requestDuration?: Histogram
	private errorCounter?: Counter
	private serviceInfo?: ObservableGauge
	private shutdownPromise?: Promise<void>
	private config: GrafanaConfig = {}

	initialize(config: GrafanaConfig) {
		this.config = config

		if (!this.config.enabled || !this.config.prometheusUrl) return
		this.shutdownPromise = undefined

		// Get encoding preference (default to protobuf for VictoriaMetrics compatibility)
		const encoding =
			this.config.prometheusEncoding || (process.env.GRAFANA_PROMETHEUS_ENCODING as 'protobuf' | 'json') || 'protobuf'

		// Create OTLP exporter with Prometheus endpoint
		const prometheusPath = process.env.GRAFANA_PROMETHEUS_PATH || '/v1/metrics'
		const exporterConfig = {
			url: `${this.config.prometheusUrl}${prometheusPath}`,
			headers: this.getAuthHeaders(),
			timeoutMillis: 10000,
			compression: 'gzip' as CompressionAlgorithm,
		}

		const exporter =
			encoding === 'protobuf' ? new OTLPMetricExporterProto(exporterConfig) : new OTLPMetricExporterHTTP(exporterConfig)

		// Create meter provider with periodic exporting
		const serviceName = this.config.serviceName || 'wisp-app'
		const instance = serviceInstance(serviceName)
		const meterProvider = new SdkMeterProvider({
			resource: resourceFromAttributes({
				[ATTR_SERVICE_NAME]: serviceName,
				[ATTR_SERVICE_VERSION]: this.config.serviceVersion || '1.0.0',
				instance,
			}),
			readers: [
				new PeriodicExportingMetricReader({
					exporter,
					exportIntervalMillis: this.config.flushIntervalMs || 5000,
				}),
			],
		})

		// Set global meter provider
		metrics.setGlobalMeterProvider(meterProvider)
		this.meterProvider = meterProvider

		// Create metrics instruments
		const meter = metrics.getMeter(this.config.serviceName || 'wisp-app')

		this.requestCounter = meter.createCounter('http_requests_total', {
			description: 'Total number of HTTP requests',
		})

		this.requestDuration = meter.createHistogram('http_request_duration_ms', {
			description: 'HTTP request duration in milliseconds',
			unit: 'ms',
		})

		this.errorCounter = meter.createCounter('errors_total', {
			description: 'Total number of errors',
		})

		this.serviceInfo = meter.createObservableGauge('service_instance_info', {
			description: 'Service instance presence',
		})
		this.serviceInfo.addCallback((result) => {
			result.observe(1, { service: serviceName, instance })
		})
	}

	private getAuthHeaders(): Record<string, string> {
		const headers: Record<string, string> = {}

		if (this.config.prometheusAuth?.bearerToken) {
			headers.Authorization = `Bearer ${this.config.prometheusAuth.bearerToken}`
		} else if (this.config.prometheusAuth?.username && this.config.prometheusAuth?.password) {
			const auth = Buffer.from(
				`${this.config.prometheusAuth.username}:${this.config.prometheusAuth.password}`,
			).toString('base64')
			headers.Authorization = `Basic ${auth}`
		}

		return headers
	}

	recordMetric(entry: MetricEntry) {
		if (!this.config.enabled) return

		const attributes = {
			method: entry.method,
			path: entry.path,
			status: String(entry.statusCode),
			service: entry.service,
		}

		// Record request count
		this.requestCounter?.add(1, attributes)

		// Record request duration
		this.requestDuration?.record(entry.duration, attributes)

		// Record errors
		if (entry.statusCode >= 400) {
			this.errorCounter?.add(1, attributes)
		}
	}

	async shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise
		if (!this.meterProvider || !('shutdown' in this.meterProvider)) return

		this.shutdownPromise = (this.meterProvider as SdkMeterProvider).shutdown()
		return this.shutdownPromise
	}
}

// ============================================================================
// Singleton Instances
// ============================================================================

export const lokiExporter = new LokiExporter()
export const metricsExporter = new MetricsExporter()

// ============================================================================
// Initialization
// ============================================================================

export function initializeGrafanaExporters(config?: GrafanaConfig) {
	const finalConfig = grafanaConfig.initialize(config || {}).getConfig()

	if (finalConfig.enabled) {
		console.log('[Observability] Initializing Grafana exporters', {
			lokiEnabled: !!finalConfig.lokiUrl,
			prometheusEnabled: !!finalConfig.prometheusUrl,
			serviceName: finalConfig.serviceName,
		})

		lokiExporter.initialize(finalConfig)
		metricsExporter.initialize(finalConfig)
	}

	return {
		lokiExporter,
		metricsExporter,
		config: finalConfig,
	}
}

// ============================================================================
// Cleanup
// ============================================================================

export async function shutdownGrafanaExporters() {
	await lokiExporter.stop()
	await metricsExporter.shutdown()
}

// Graceful shutdown handlers
if (typeof process !== 'undefined') {
	process.on('SIGTERM', shutdownGrafanaExporters)
	process.on('SIGINT', shutdownGrafanaExporters)
}
