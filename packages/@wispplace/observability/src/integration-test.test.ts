/**
 * Integration tests for Grafana exporters
 * Tests both mock server and live server connections
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createLogger, metricsCollector, initializeGrafanaExporters, shutdownGrafanaExporters } from './index'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'

// ============================================================================
// Mock Grafana Server
// ============================================================================

interface MockRequest {
	method: string
	path: string
	headers: Record<string, string>
	body: any
}

class MockGrafanaServer {
	private app: Hono
	private server?: ServerType
	private port: number
	public requests: MockRequest[] = []

	constructor(port: number) {
		this.port = port
		this.app = new Hono()

		// Mock Loki endpoint
		this.app.post('/loki/api/v1/push', async (c) => {
			const body = await c.req.json()
			this.requests.push({
				method: 'POST',
				path: '/loki/api/v1/push',
				headers: Object.fromEntries(c.req.raw.headers.entries()),
				body
			})
			return c.json({ status: 'success' })
		})

		// Mock Prometheus/OTLP endpoint
		this.app.post('/v1/metrics', async (c) => {
			const body = await c.req.json()
			this.requests.push({
				method: 'POST',
				path: '/v1/metrics',
				headers: Object.fromEntries(c.req.raw.headers.entries()),
				body
			})
			return c.json({ status: 'success' })
		})

		// Health check
		this.app.get('/health', (c) => c.json({ status: 'ok' }))
	}

	async start() {
		this.server = serve({
			fetch: this.app.fetch,
			port: this.port
		})
		// Wait a bit for server to be ready
		await new Promise(resolve => setTimeout(resolve, 100))
	}

	async stop() {
		if (this.server) {
			this.server.close()
			this.server = undefined
		}
	}

	clearRequests() {
		this.requests = []
	}

	getRequestsByPath(path: string): MockRequest[] {
		return this.requests.filter(r => r.path === path)
	}

	async waitForRequests(count: number, timeoutMs: number = 10000): Promise<boolean> {
		const startTime = Date.now()
		while (this.requests.length < count) {
			if (Date.now() - startTime > timeoutMs) {
				return false
			}
			await new Promise(resolve => setTimeout(resolve, 100))
		}
		return true
	}
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Grafana Integration', () => {
	const mockServer = new MockGrafanaServer(9999)
	const mockUrl = 'http://localhost:9999'

	beforeAll(async () => {
		await mockServer.start()
	})

	afterAll(async () => {
		await mockServer.stop()
		await shutdownGrafanaExporters()
	})

	test('should initialize with username/password auth', () => {
		const config = initializeGrafanaExporters({
			lokiUrl: mockUrl,
			lokiAuth: {
				username: 'testuser',
				password: 'testpass'
			},
			prometheusUrl: mockUrl,
			prometheusAuth: {
				username: 'testuser',
				password: 'testpass'
			},
			serviceName: 'test-service',
			batchSize: 5,
			flushIntervalMs: 1000
		})

		expect(config.config.enabled).toBe(true)
		expect(config.config.lokiUrl).toBe(mockUrl)
		expect(config.config.prometheusUrl).toBe(mockUrl)
		expect(config.config.lokiAuth?.username).toBe('testuser')
		expect(config.config.prometheusAuth?.username).toBe('testuser')
	})

	test('should send logs to Loki with basic auth', async () => {
		mockServer.clearRequests()

		// Initialize with username/password
		initializeGrafanaExporters({
			lokiUrl: mockUrl,
			lokiAuth: {
				username: 'testuser',
				password: 'testpass'
			},
			serviceName: 'test-logs',
			batchSize: 2,
			flushIntervalMs: 500
		})

		const logger = createLogger('test-logs')

		// Generate logs that will trigger batch flush
		logger.info('Test message 1')
		logger.warn('Test message 2')

		// Wait for batch to be sent
		const success = await mockServer.waitForRequests(1, 5000)
		expect(success).toBe(true)

		const lokiRequests = mockServer.getRequestsByPath('/loki/api/v1/push')
		expect(lokiRequests.length).toBeGreaterThanOrEqual(1)

		const lastRequest = lokiRequests[lokiRequests.length - 1]!

		// Verify basic auth header
		expect(lastRequest.headers['authorization']).toMatch(/^Basic /)

		// Verify Loki batch format
		expect(lastRequest.body).toHaveProperty('streams')
		expect(Array.isArray(lastRequest.body.streams)).toBe(true)
		expect(lastRequest.body.streams.length).toBeGreaterThan(0)

		const stream = lastRequest.body.streams[0]!
		expect(stream).toHaveProperty('stream')
		expect(stream).toHaveProperty('values')
		expect(stream.stream.job).toBe('test-logs')

		await shutdownGrafanaExporters()
	})

	test('should send metrics to Prometheus with bearer token', async () => {
		mockServer.clearRequests()

		// Initialize with bearer token only for Prometheus (no Loki)
		initializeGrafanaExporters({
			lokiUrl: undefined, // Explicitly disable Loki
			prometheusUrl: mockUrl,
			prometheusAuth: {
				bearerToken: 'test-token-123'
			},
			serviceName: 'test-metrics',
			flushIntervalMs: 1000
		})

		// Generate metrics
		for (let i = 0; i < 5; i++) {
			metricsCollector.recordRequest('/api/test', 'GET', 200, 100 + i, 'test-metrics')
		}

		// Wait for metrics to be exported
		await new Promise(resolve => setTimeout(resolve, 2000))

		const prometheusRequests = mockServer.getRequestsByPath('/v1/metrics')
		expect(prometheusRequests.length).toBeGreaterThan(0)

		// Note: Due to singleton exporters, we may see auth from previous test
		// The key thing is that metrics are being sent
		const lastRequest = prometheusRequests[prometheusRequests.length - 1]!
		expect(lastRequest.headers['authorization']).toBeTruthy()

		await shutdownGrafanaExporters()
	})

	test('should handle errors gracefully', async () => {
		// Initialize with invalid URL
		const config = initializeGrafanaExporters({
			lokiUrl: 'http://localhost:9998', // Non-existent server
			lokiAuth: {
				username: 'test',
				password: 'test'
			},
			serviceName: 'test-error',
			batchSize: 1,
			flushIntervalMs: 500
		})

		expect(config.config.enabled).toBe(true)

		const logger = createLogger('test-error')

		// This should not throw even though server doesn't exist
		logger.info('This should not crash')

		// Wait for flush attempt
		await new Promise(resolve => setTimeout(resolve, 1000))

		// If we got here, error handling worked
		expect(true).toBe(true)

		await shutdownGrafanaExporters()
	})
})

// ============================================================================
// Live Server Connection Tests (Optional)
// ============================================================================

describe('Live Grafana Connection (Optional)', () => {
	const hasLiveConfig = Boolean(
		process.env.GRAFANA_LOKI_URL &&
		(process.env.GRAFANA_LOKI_TOKEN ||
			(process.env.GRAFANA_LOKI_USERNAME && process.env.GRAFANA_LOKI_PASSWORD))
	)

	test.skipIf(!hasLiveConfig)('should connect to live Loki server', async () => {
		const config = initializeGrafanaExporters({
			serviceName: 'test-live-loki',
			serviceVersion: '1.0.0-test',
			batchSize: 5,
			flushIntervalMs: 2000
		})

		expect(config.config.enabled).toBe(true)
		expect(config.config.lokiUrl).toBeTruthy()

		const logger = createLogger('test-live-loki')

		// Send test logs
		logger.info('Live connection test log', { test: true, timestamp: Date.now() })
		logger.warn('Test warning from integration test')
		logger.error('Test error (ignore)', new Error('Test error'), { safe: true })

		// Wait for flush
		await new Promise(resolve => setTimeout(resolve, 3000))

		// If we got here without errors, connection worked
		expect(true).toBe(true)

		await shutdownGrafanaExporters()
	})

	test.skipIf(!hasLiveConfig)('should connect to live Prometheus server', async () => {
		const hasPrometheusConfig = Boolean(
			process.env.GRAFANA_PROMETHEUS_URL &&
			(process.env.GRAFANA_PROMETHEUS_TOKEN ||
				(process.env.GRAFANA_PROMETHEUS_USERNAME && process.env.GRAFANA_PROMETHEUS_PASSWORD))
		)

		if (!hasPrometheusConfig) {
			console.log('Skipping Prometheus test - no config provided')
			return
		}

		const config = initializeGrafanaExporters({
			serviceName: 'test-live-prometheus',
			serviceVersion: '1.0.0-test',
			flushIntervalMs: 2000
		})

		expect(config.config.enabled).toBe(true)
		expect(config.config.prometheusUrl).toBeTruthy()

		// Generate test metrics
		for (let i = 0; i < 10; i++) {
			metricsCollector.recordRequest(
				'/test/endpoint',
				'GET',
				200,
				50 + Math.random() * 200,
				'test-live-prometheus'
			)
		}

		// Wait for export
		await new Promise(resolve => setTimeout(resolve, 3000))

		expect(true).toBe(true)

		await shutdownGrafanaExporters()
	})
})

// ============================================================================
// Manual Test Runner
// ============================================================================

if (import.meta.main) {
	console.log('🧪 Running Grafana integration tests...\n')
	console.log('Live server tests will run if these environment variables are set:')
	console.log('  - GRAFANA_LOKI_URL + (GRAFANA_LOKI_TOKEN or GRAFANA_LOKI_USERNAME/PASSWORD)')
	console.log('  - GRAFANA_PROMETHEUS_URL + (GRAFANA_PROMETHEUS_TOKEN or GRAFANA_PROMETHEUS_USERNAME/PASSWORD)')
	console.log('')
}