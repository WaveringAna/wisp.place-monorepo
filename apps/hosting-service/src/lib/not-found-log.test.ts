import { describe, expect, jest, test } from 'bun:test'
import { createNotFoundLog, type NotFoundSummary, notFoundHostKey } from './not-found-log'

function collectingLog(options: { maxHostsPerReason?: number; now?: () => number } = {}) {
	const lines: NotFoundSummary[] = []
	const log = createNotFoundLog({ ...options, emit: (summary) => lines.push(summary) })
	return { log, lines }
}

describe('404 summary log', () => {
	test('folds a window into one line per reason with its top 5 hosts', () => {
		let clock = Date.parse('2026-10-08T00:00:00.000Z')
		const { log, lines } = collectingLog({ now: () => clock++ })
		const hits = {
			'dead.example.com': 40,
			'a.example': 7,
			'b.example': 6,
			'c.example': 5,
			'd.example': 4,
			'e.example': 3,
		}
		for (const [host, count] of Object.entries(hits))
			for (let i = 0; i < count; i++) log.record('unknown-custom-domain', host)
		log.record('file-not-found', 'alice.wisp.place')

		expect(lines).toHaveLength(0)
		expect(log.flush()).toBe(2)
		expect(lines).toEqual([
			{
				reason: 'unknown-custom-domain',
				count: 65,
				hosts: 6,
				untracked: 0,
				top: [
					{ host: 'dead.example.com', count: 40 },
					{ host: 'a.example', count: 7 },
					{ host: 'b.example', count: 6 },
					{ host: 'c.example', count: 5 },
					{ host: 'd.example', count: 4 },
				],
				firstAt: '2026-10-08T00:00:00.000Z',
				lastAt: '2026-10-08T00:00:00.064Z',
			},
			{
				reason: 'file-not-found',
				count: 1,
				hosts: 1,
				untracked: 0,
				top: [{ host: 'alice.wisp.place', count: 1 }],
				firstAt: '2026-10-08T00:00:00.065Z',
				lastAt: '2026-10-08T00:00:00.065Z',
			},
		])
		expect(log.flush()).toBe(0)
	})

	test('a flood of 10k distinct hosts keeps at most the cap and still counts every 404', () => {
		const { log, lines } = collectingLog({ maxHostsPerReason: 256 })
		for (let i = 0; i < 10_000; i++) log.record('unknown-custom-domain', `scanner-${i}.example.net`)
		// A host already tracked keeps its own count after the cap is reached.
		for (let i = 0; i < 50; i++) log.record('unknown-custom-domain', 'scanner-3.example.net')

		expect(log.trackedHosts()).toBe(256)
		log.flush()
		const [line] = lines
		expect(line?.count).toBe(10_050)
		expect(line?.hosts).toBe(256)
		expect(line?.untracked).toBe(10_000 - 256)
		expect(line?.top).toHaveLength(5)
		expect(line?.top[0]).toEqual({ host: 'scanner-3.example.net', count: 51 })
		expect(log.trackedHosts()).toBe(0)
	})

	test('every reason is capped on its own, bounding the whole window', () => {
		const { log } = collectingLog({ maxHostsPerReason: 10 })
		for (let i = 0; i < 1000; i++) {
			log.record('unknown-custom-domain', `a-${i}.example`)
			log.record('file-not-found', `b-${i}.example`)
		}
		expect(log.trackedHosts()).toBe(20)
	})

	test('hosts are truncated, IP literals hidden and unsafe characters replaced', () => {
		expect(notFoundHostKey(`${'a'.repeat(100)}.example`)).toBe('a'.repeat(80))
		expect(notFoundHostKey('203.0.113.9')).toBe('ip-literal')
		expect(notFoundHostKey('203.0.113.9/did:plc:x/site')).toBe('ip-literal')
		expect(notFoundHostKey('[2001:db8::1]')).toBe('ip-literal')
		expect(notFoundHostKey('evil.example\n{"level":"error"}')).toBe('evil.example???level?:?error??')
		expect(notFoundHostKey('sites.wisp.place/did:plc:abc/my-site')).toBe('sites.wisp.place/did:plc:abc/my-site')
	})

	test('flushes on its window timer and once more on stop', () => {
		jest.useFakeTimers()
		try {
			const lines: NotFoundSummary[] = []
			const log = createNotFoundLog({ windowMs: 60_000, emit: (summary) => lines.push(summary) })
			log.start()
			log.start()

			log.record('other', 'wisp.place')
			jest.advanceTimersByTime(60_000)
			expect(lines.map(({ count }) => count)).toEqual([1])

			log.record('other', 'wisp.place')
			expect(log.stop()).toBe(1)
			expect(lines.map(({ count }) => count)).toEqual([1, 1])

			log.record('other', 'wisp.place')
			jest.advanceTimersByTime(120_000)
			expect(lines).toHaveLength(2)
		} finally {
			jest.useRealTimers()
		}
	})
})
