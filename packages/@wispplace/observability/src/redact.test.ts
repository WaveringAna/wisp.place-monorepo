import { describe, expect, test } from 'bun:test'
import { errorTracker, logCollector, metricsCollector } from './core'
import { lokiExporter } from './exporters'
import { redactSecretPath, sanitizeForLog, sanitizeLogString } from './redact'

const fakeMarkers = [
	'FAKE_POSTGRES_USERINFO_DO_NOT_LOG',
	'FAKE_POSTGRESQL_USERINFO_DO_NOT_LOG',
	'FAKE_REDIS_USERINFO_DO_NOT_LOG',
	'FAKE_REDISS_USERINFO_DO_NOT_LOG',
	'FAKE_HTTP_USERINFO_DO_NOT_LOG',
	'FAKE_HTTPS_USERINFO_DO_NOT_LOG',
	'FAKE_BEARER_DO_NOT_LOG',
	'FAKE_BASIC_DO_NOT_LOG',
	'FAKE_QUERY_TOKEN_DO_NOT_LOG',
	'FAKE_QUERY_PASSWORD_DO_NOT_LOG',
	'FAKE_FIELD_PASSWORD_DO_NOT_LOG',
	'FAKE_COOKIE_DO_NOT_LOG',
	'FAKE_SECRET_KEY_DO_NOT_LOG',
	'FAKE_STACK_PASSWORD_DO_NOT_LOG',
	'FAKE_PRIVATE_PATH_TOKEN_DO_NOT_LOG',
	'FAKE_SHARE_QUERY_TOKEN_DO_NOT_LOG',
	'FAKE_HANDOFF_QUERY_TOKEN_DO_NOT_LOG',
	'FAKE_ENCODED_QUERY_TOKEN_DO_NOT_LOG',
]

function expectNoFakeSecrets(value: unknown): void {
	const serialized = JSON.stringify(value)
	for (const marker of fakeMarkers) {
		expect(serialized).not.toContain(marker)
	}
}

function fakeCredentialText(): string {
	return [
		'postgres://fake-user:FAKE_POSTGRES_USERINFO_DO_NOT_LOG@db.example.test/wisp?password=FAKE_QUERY_PASSWORD_DO_NOT_LOG',
		'postgresql://fake-user:FAKE_POSTGRESQL_USERINFO_DO_NOT_LOG@db.example.test/wisp?token=FAKE_QUERY_TOKEN_DO_NOT_LOG',
		'redis://fake-user:FAKE_REDIS_USERINFO_DO_NOT_LOG@cache.example.test/0',
		'rediss://fake-user:FAKE_REDISS_USERINFO_DO_NOT_LOG@cache.example.test/0',
		'http://fake-user:FAKE_HTTP_USERINFO_DO_NOT_LOG@api.example.test/v1',
		'https://fake-user:FAKE_HTTPS_USERINFO_DO_NOT_LOG@api.example.test/v1?access_token=FAKE_QUERY_TOKEN_DO_NOT_LOG',
		'Bearer FAKE_BEARER_DO_NOT_LOG',
		'Basic FAKE_BASIC_DO_NOT_LOG',
	].join(' | ')
}

describe('observability redaction', () => {
	test('recursively redacts credentials while retaining ordinary identifiers', () => {
		const nestedError = new TypeError(
			`Connection failed: ${fakeCredentialText()} password=FAKE_STACK_PASSWORD_DO_NOT_LOG`,
		)
		nestedError.stack = `TypeError: ${nestedError.message}\n    at fake.test.ts:1:1`

		const cycle: Record<string, unknown> = { did: 'did:plc:exampledid123' }
		cycle.self = cycle

		let deep: Record<string, unknown> = {}
		const deepRoot = deep
		for (let index = 0; index < 12; index++) {
			deep.next = {}
			deep = deep.next as Record<string, unknown>
		}
		deep.token = 'FAKE_QUERY_TOKEN_DO_NOT_LOG'

		const sanitized = sanitizeForLog({
			PASSWORD: 'FAKE_FIELD_PASSWORD_DO_NOT_LOG',
			Cookie: 'session=FAKE_COOKIE_DO_NOT_LOG',
			secretKey: 'FAKE_SECRET_KEY_DO_NOT_LOG',
			connectionString: 'postgres://fake-user:FAKE_POSTGRES_USERINFO_DO_NOT_LOG@db.example.test/wisp',
			details: fakeCredentialText(),
			error: nestedError,
			cycle,
			deepRoot,
			many: Array.from({ length: 60 }, (_, index) => (index === 59 ? 'FAKE_QUERY_TOKEN_DO_NOT_LOG' : index)),
			did: 'did:plc:exampledid123',
			rkey: '3kexample-rkey',
			domain: 'site.example.test',
			path: '/sites/did:plc:exampledid123/assets/index.html',
			privatePath: '/p/FAKE_PRIVATE_PATH_TOKEN_DO_NOT_LOG',
		})

		expectNoFakeSecrets(sanitized)
		expect(JSON.stringify(sanitized)).toContain('TypeError')
		expect(JSON.stringify(sanitized)).toContain('<circular>')
		expect(JSON.stringify(sanitized)).toContain('<truncated>')
		expect(JSON.stringify(sanitized)).toContain('did:plc:exampledid123')
		expect(JSON.stringify(sanitized)).toContain('3kexample-rkey')
		expect(JSON.stringify(sanitized)).toContain('site.example.test')
		expect(JSON.stringify(sanitized)).toContain('/sites/did:plc:exampledid123/assets/index.html')

		const jsonMessage = sanitizeLogString('{"SECRET_KEY":"FAKE_SECRET_KEY_DO_NOT_LOG"}')
		expect(jsonMessage).toBe('{"SECRET_KEY":"<redacted>"}')
	})

	test('redacts private k and g link credentials in URLs, middleware paths, and stacks', () => {
		const shareToken = 'wss_FAKE_SHARE_QUERY_TOKEN_DO_NOT_LOG'
		const handoffToken = 'wsh_FAKE_HANDOFF_QUERY_TOKEN_DO_NOT_LOG'
		const encodedToken = 'wss_FAKE_ENCODED_QUERY_TOKEN_DO_NOT_LOG'
		const absoluteUrl = `https://private.example.test/open?k=${shareToken}&did=did:plc:exampledid123`
		const relativeUrl = `/open?first=one&g=${handoffToken}&last=two`
		const encodedDelimiterUrl = `/open?next=one%26k%3D${encodeURIComponent(encodedToken)}%26last%3Dtwo`
		const encodedAssignmentUrl = `/open?k%3D${encodeURIComponent(encodedToken)}&last=two`
		const middlewarePath = redactSecretPath(`/sites/did:plc:exampledid123?first=one&k=${shareToken}&last=two`)
		const error = new Error(`Private handoff failed: ${absoluteUrl}`)
		error.stack = `Error: ${error.message}\n    at ${relativeUrl}\n    at ${encodedDelimiterUrl}`

		const sanitized = {
			absoluteUrl: sanitizeLogString(absoluteUrl),
			relativeUrl: sanitizeLogString(relativeUrl),
			encodedDelimiterUrl: sanitizeLogString(encodedDelimiterUrl),
			encodedAssignmentUrl: sanitizeLogString(encodedAssignmentUrl),
			middlewarePath,
			error: sanitizeForLog(error),
		}

		expectNoFakeSecrets(sanitized)
		expect(sanitized.absoluteUrl).toContain('did=did:plc:exampledid123')
		expect(sanitized.relativeUrl).toContain('first=one&g=<redacted>&last=two')
		expect(sanitized.middlewarePath).toContain('first=one&k=<redacted>&last=two')
		expect(sanitizeLogString('/open?k')).toBe('/open?k=<redacted>')
		expect(sanitizeLogString('/open?g&last=two')).toBe('/open?g=<redacted>&last=two')
		expect(sanitizeLogString('ordinary k and g text; k=value, g=value, /k/path')).toBe(
			'ordinary k and g text; k=value, g=value, /k/path',
		)
	})

	test('sanitizes entries before console, in-memory storage, and Loki', () => {
		logCollector.clear()
		errorTracker.clear()
		metricsCollector.clear()

		const pushedToLoki: unknown[] = []
		const consoleOutput: string[] = []
		const originalPushLog = lokiExporter.pushLog
		const originalPushError = lokiExporter.pushError
		const originalConsoleError = console.error

		lokiExporter.pushLog = (entry) => {
			pushedToLoki.push(entry)
		}
		lokiExporter.pushError = (entry) => {
			pushedToLoki.push(entry)
		}
		console.error = ((...args: unknown[]) => {
			consoleOutput.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
		}) as typeof console.error

		try {
			const rawError = new TypeError(`Request failed: ${fakeCredentialText()} password=FAKE_STACK_PASSWORD_DO_NOT_LOG`)
			rawError.stack = `TypeError: ${rawError.message}\n    at fake.test.ts:1:1`
			const context = {
				Authorization: 'Bearer FAKE_BEARER_DO_NOT_LOG',
				cookie: 'session=FAKE_COOKIE_DO_NOT_LOG',
				password: 'FAKE_FIELD_PASSWORD_DO_NOT_LOG',
				endpoint:
					'https://fake-user:FAKE_HTTPS_USERINFO_DO_NOT_LOG@api.example.test/v1?token=FAKE_QUERY_TOKEN_DO_NOT_LOG',
				childError: rawError,
				did: 'did:plc:exampledid123',
				rkey: '3kexample-rkey',
				domain: 'site.example.test',
				path: '/sites/did:plc:exampledid123/assets/index.html',
				privatePath: '/p/FAKE_PRIVATE_PATH_TOKEN_DO_NOT_LOG',
			}

			logCollector.error(`Cannot connect: ${fakeCredentialText()}`, 'redaction-boundary-test', rawError, context)
			errorTracker.track(`Tracker failed: ${fakeCredentialText()}`, 'redaction-tracker-test', rawError, context)
			metricsCollector.recordRequest(
				'https://fake-user:FAKE_HTTPS_USERINFO_DO_NOT_LOG@api.example.test/v1?token=FAKE_QUERY_TOKEN_DO_NOT_LOG',
				'GET',
				500,
				12,
				'redaction-metrics-test',
			)

			const logs = logCollector.getLogs({ service: 'redaction-boundary-test' })
			const trackedErrors = errorTracker.getErrors()
			const recordedMetrics = metricsCollector.getMetrics({ service: 'redaction-metrics-test' })

			expect(logs).toHaveLength(1)
			expect(trackedErrors).toHaveLength(2)
			expect(recordedMetrics).toHaveLength(1)
			expect(pushedToLoki).toHaveLength(3)
			expect(consoleOutput).toHaveLength(1)

			expectNoFakeSecrets(logs)
			expectNoFakeSecrets(trackedErrors)
			expectNoFakeSecrets(recordedMetrics)
			expectNoFakeSecrets(pushedToLoki)
			expectNoFakeSecrets(consoleOutput)

			const serializedLogs = JSON.stringify(logs)
			expect(serializedLogs).toContain('TypeError')
			expect(serializedLogs).toContain('did:plc:exampledid123')
			expect(serializedLogs).toContain('3kexample-rkey')
			expect(serializedLogs).toContain('site.example.test')
			expect(serializedLogs).toContain('/sites/did:plc:exampledid123/assets/index.html')
		} finally {
			lokiExporter.pushLog = originalPushLog
			lokiExporter.pushError = originalPushError
			console.error = originalConsoleError
			logCollector.clear()
			errorTracker.clear()
			metricsCollector.clear()
		}
	})
})
