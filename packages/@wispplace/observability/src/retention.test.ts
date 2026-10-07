import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { logCollector, metricsCollector, setInMemoryRetention } from './core'

const service = 'retention-test'

afterEach(() => {
	setInMemoryRetention({ logs: 5000, metrics: 10000 })
	logCollector.clear()
	metricsCollector.clear()
})

describe('setInMemoryRetention', () => {
	test('keeps no log or metric entries at zero, while console output continues', () => {
		const info = spyOn(console, 'info').mockImplementation(() => {})
		try {
			setInMemoryRetention({ logs: 0, metrics: 0 })
			logCollector.info('[Retention] still printed', service)
			metricsCollector.recordRequest('/*', 'GET', 200, 3, service)

			expect(logCollector.getLogs({ service })).toHaveLength(0)
			expect(metricsCollector.getMetrics({ service })).toHaveLength(0)
			expect(info).toHaveBeenCalledWith('[retention-test] [Retention] still printed')
		} finally {
			info.mockRestore()
		}
	})

	test('trims existing entries to a smaller ring and keeps the newest', () => {
		const info = spyOn(console, 'info').mockImplementation(() => {})
		try {
			for (let index = 0; index < 5; index++) {
				logCollector.info(`entry ${index}`, service)
				metricsCollector.recordRequest(`/${index}`, 'GET', 200, 1, service)
			}
			setInMemoryRetention({ logs: 2, metrics: 3 })
			logCollector.info('entry 5', service)

			expect(logCollector.getLogs({ service }).map((log) => log.message)).toEqual(['entry 5', 'entry 4'])
			expect(metricsCollector.getMetrics({ service }).map((metric) => metric.path)).toEqual(['/4', '/3', '/2'])
		} finally {
			info.mockRestore()
		}
	})
})
