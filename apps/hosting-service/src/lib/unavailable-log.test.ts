import { describe, expect, jest, test } from 'bun:test'
import { createUnavailableLog, OVERFLOW_SITE, type UnavailableSummary } from './unavailable-log'

const DID = 'did:plc:test'

function collectingLog(options: { maxSites?: number; now?: () => number } = {}) {
	const lines: UnavailableSummary[] = []
	const log = createUnavailableLog({ ...options, emit: (summary) => lines.push(summary) })
	return { log, lines }
}

describe('fail-closed 503 summary log', () => {
	test('folds 1000 failures of one site and reason into one line per window', () => {
		let clock = Date.parse('2026-10-08T00:18:00.000Z')
		const { log, lines } = collectingLog({ now: () => clock++ })

		for (let i = 0; i < 1000; i++) {
			log.record(DID, 'blog', 'cid-mismatch', i === 0 ? 'enqueued' : 'deduped')
		}
		expect(lines).toHaveLength(0)

		expect(log.flush()).toBe(1)
		expect(lines).toEqual([
			{
				site: `${DID}/blog`,
				reason: 'cid-mismatch',
				count: 1000,
				firstAt: '2026-10-08T00:18:00.000Z',
				lastAt: '2026-10-08T00:18:00.999Z',
				revalidate: { enqueued: 1, deduped: 999 },
			},
		])
	})

	test('keeps one line per reason and starts a fresh window after each flush', () => {
		const { log, lines } = collectingLog()
		log.record(DID, 'blog', 'updating', 'none')
		log.record(DID, 'blog', 'storage-unavailable', 'none')
		log.record(DID, 'docs', 'updating', 'none')
		expect(log.flush()).toBe(3)
		expect(lines.map(({ site, reason, count }) => [site, reason, count])).toEqual([
			[`${DID}/blog`, 'updating', 1],
			[`${DID}/blog`, 'storage-unavailable', 1],
			[`${DID}/docs`, 'updating', 1],
		])

		expect(log.flush()).toBe(0)
		expect(lines).toHaveLength(3)
	})

	test('logs nothing when no request failed closed', () => {
		const { log, lines } = collectingLog()
		expect(log.flush()).toBe(0)
		expect(log.stop()).toBe(0)
		expect(lines).toEqual([])
	})

	test('caps distinct sites per window and counts the rest under other', () => {
		const { log, lines } = collectingLog({ maxSites: 3 })
		for (let site = 0; site < 10_000; site++) log.record(DID, `site-${site}`, 'cid-miss', 'deduped')
		// Sites already tracked keep their own bucket after the cap is reached.
		log.record(DID, 'site-0', 'cid-miss', 'deduped')

		expect(log.trackedSites()).toBe(4)
		log.flush()
		expect(lines.map(({ site, count }) => [site, count])).toEqual([
			[`${DID}/site-0`, 2],
			[`${DID}/site-1`, 1],
			[`${DID}/site-2`, 1],
			[OVERFLOW_SITE, 9_997],
		])
	})

	test('flushes on its window timer and once more on stop', () => {
		jest.useFakeTimers()
		try {
			const lines: UnavailableSummary[] = []
			const log = createUnavailableLog({ windowMs: 60_000, emit: (summary) => lines.push(summary) })
			log.start()
			log.start()

			log.record(DID, 'blog', 'manifest-miss', 'enqueued')
			jest.advanceTimersByTime(60_000)
			expect(lines.map(({ count }) => count)).toEqual([1])

			log.record(DID, 'blog', 'manifest-miss', 'deduped')
			expect(log.stop()).toBe(1)
			expect(lines.map(({ count }) => count)).toEqual([1, 1])

			log.record(DID, 'blog', 'manifest-miss', 'deduped')
			jest.advanceTimersByTime(120_000)
			expect(lines).toHaveLength(2)
		} finally {
			jest.useRealTimers()
		}
	})
})
