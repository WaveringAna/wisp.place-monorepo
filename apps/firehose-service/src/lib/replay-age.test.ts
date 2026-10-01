import { describe, expect, test } from 'bun:test'
import {
	evaluateReplayAge,
	observeSourceEvent,
	parseSourceTime,
	REPLAY_READY_MAX_AGE_MS,
	resetSourceProgress,
	staleReplayReport,
} from './replay-age'

const now = Date.parse('2026-05-01T12:00:00.000Z')
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()

describe('replay age', () => {
	test('rejects invalid and future timestamps', () => {
		expect(parseSourceTime('nope', now)).toBeUndefined()
		expect(parseSourceTime('', now)).toBeUndefined()
		expect(parseSourceTime(undefined, now)).toBeUndefined()
		expect(parseSourceTime(iso(10 * 60_000), now)).toBeUndefined()
		expect(parseSourceTime(iso(5_000), now)).toBe(now + 5_000)
	})

	test('recent event is caught up and reports sequence', () => {
		const p = observeSourceEvent(resetSourceProgress('primary'), { seq: 7, time: iso(-30_000) }, now)
		expect(p.sequence).toBe(7)
		expect(evaluateReplayAge(p, now)).toEqual({ status: 'caught-up', replayAgeMs: 30_000, ready: true })
	})

	test('stale event is catching up and not ready', () => {
		const p = observeSourceEvent(resetSourceProgress('secondary'), { seq: 1, time: iso(-26 * 3_600_000) }, now)
		const age = evaluateReplayAge(p, now)
		expect(age.status).toBe('catching-up')
		expect(age.ready).toBe(false)
		expect(age.replayAgeMs).toBe(26 * 3_600_000)
	})

	test('threshold is inclusive', () => {
		const p = observeSourceEvent(resetSourceProgress('primary'), { seq: 1, time: iso(-REPLAY_READY_MAX_AGE_MS) }, now)
		expect(evaluateReplayAge(p, now).ready).toBe(true)
		expect(evaluateReplayAge(p, now + 1).ready).toBe(false)
	})

	test('invalid or future timestamps never claim ready, even after a fresh one', () => {
		const fresh = observeSourceEvent(resetSourceProgress('primary'), { seq: 1, time: iso(-1_000) }, now)
		for (const time of ['garbage', iso(3_600_000), undefined]) {
			const p = observeSourceEvent(fresh, { seq: 2, time }, now)
			expect(evaluateReplayAge(p, now)).toEqual({ status: 'invalid', ready: false })
			expect(p.sequence).toBe(2)
		}
	})

	test('reset on start or relay switch forgets prior age', () => {
		const fresh = observeSourceEvent(resetSourceProgress('primary'), { seq: 1, time: iso(-1_000) }, now)
		expect(evaluateReplayAge(fresh, now).ready).toBe(true)
		const switched = resetSourceProgress('secondary')
		expect(switched.relay).toBe('secondary')
		expect(evaluateReplayAge(switched, now)).toEqual({ status: 'unknown', ready: false })
	})

	test('same-relay reconnect keeps stale age (no false freshness)', () => {
		const stale = observeSourceEvent(resetSourceProgress('primary'), { seq: 1, time: iso(-3_600_000) }, now)
		expect(evaluateReplayAge(stale, now + 120_000).ready).toBe(false)
	})

	test('warns once on the first stale event, then stays quiet as it catches up', () => {
		const start = resetSourceProgress('primary')
		const first = observeSourceEvent(start, { seq: 1, time: iso(-3_600_000) }, now)
		expect(staleReplayReport(start, first, now)).toEqual({
			relay: 'primary',
			sourceTime: iso(-3_600_000),
			replayAgeMs: 3_600_000,
		})
		const second = observeSourceEvent(first, { seq: 2, time: iso(-3_000_000) }, now)
		expect(staleReplayReport(first, second, now)).toBeUndefined()
		const live = observeSourceEvent(second, { seq: 3, time: iso(-1_000) }, now)
		expect(staleReplayReport(second, live, now)).toBeUndefined()
	})

	test('no warning for a fresh, invalid, or post-reset-fresh first event', () => {
		const start = resetSourceProgress('secondary')
		expect(staleReplayReport(start, observeSourceEvent(start, { seq: 1, time: iso(-1_000) }, now), now)).toBeUndefined()
		expect(staleReplayReport(start, observeSourceEvent(start, { seq: 1, time: 'bad' }, now), now)).toBeUndefined()
	})

	test('a relay switch re-arms the warning', () => {
		const old = observeSourceEvent(resetSourceProgress('primary'), { seq: 1, time: iso(-1_000) }, now)
		const switched = resetSourceProgress('secondary')
		const first = observeSourceEvent(switched, { seq: 9, time: iso(-7_200_000) }, now)
		expect(staleReplayReport(old, observeSourceEvent(old, { seq: 2, time: iso(-7_200_000) }, now), now)).toBeUndefined()
		expect(staleReplayReport(switched, first, now)?.relay).toBe('secondary')
	})
})
