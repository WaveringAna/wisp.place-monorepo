import { describe, expect, test } from 'bun:test'
import { OrderedCursorTracker } from './firehose-cursor'
import { RelayCursorCoordinator, type RelayCursorStore, StandbyCursorAdvancer } from './firehose-relay'
import { type ProbedPosition, type RelayProbe, seekRelayCursorByTime } from './relay-seek'

const T0 = Date.parse('2026-09-30T00:00:00Z')

/** A relay retaining seqs [oldest, head] at `rate` events/second starting at T0 for seq `base`. */
function simulatedRelay(opts: { base: number; oldest: number; head: number; rate: number; jitterMs?: number }) {
	const timeOf = (seq: number) => {
		const jitter = opts.jitterMs ? ((seq * 7919) % 3) - 1 : 0
		return T0 + ((seq - opts.base) / opts.rate) * 1000 + jitter * (opts.jitterMs ?? 0)
	}
	const calls: Array<number | undefined> = []
	const probe: RelayProbe = async (cursor) => {
		calls.push(cursor)
		const seq = cursor === undefined ? opts.head : Math.min(opts.head, Math.max(opts.oldest, cursor + 1))
		return { seq, timeMs: timeOf(seq) }
	}
	return { probe, calls, timeOf }
}

describe('seekRelayCursorByTime', () => {
	test('lands at or just behind the target time', async () => {
		// 26h of history at 300 events/s, mirroring the secondary relay.
		const relay = simulatedRelay({ base: 16_000_000_000, oldest: 16_000_000_000, head: 16_028_080_000, rate: 300 })
		const target = T0 + 20 * 3600_000
		const result = await seekRelayCursorByTime(relay.probe, target)
		expect(result.beyondRetention).toBe(false)
		expect(result.timeMs).toBeLessThanOrEqual(target)
		expect(target - result.timeMs).toBeLessThanOrEqual(60_000)
		expect(result.probes).toBeLessThanOrEqual(48)
	})

	test('starts from the head when the relay is not past the target', async () => {
		const relay = simulatedRelay({ base: 1_000, oldest: 1_000, head: 2_000, rate: 1 })
		const result = await seekRelayCursorByTime(relay.probe, relay.timeOf(2_000) + 5_000)
		expect(result).toEqual({ cursor: 1_999, timeMs: relay.timeOf(2_000), probes: 1, beyondRetention: false })
	})

	test('reports when the relay no longer retains the target time', async () => {
		const relay = simulatedRelay({ base: 0, oldest: 5_000_000, head: 6_000_000, rate: 100 })
		const result = await seekRelayCursorByTime(relay.probe, T0 + 1_000)
		expect(result.beyondRetention).toBe(true)
		// The relay answers from its oldest event; resuming there replays everything it still has.
		expect(result.timeMs).toBe(relay.timeOf(5_000_000))
	})

	test('never returns a cursor past the target despite timestamp jitter', async () => {
		const relay = simulatedRelay({ base: 0, oldest: 0, head: 10_000_000, rate: 400, jitterMs: 2_000 })
		const target = T0 + 3 * 3600_000
		const result = await seekRelayCursorByTime(relay.probe, target, { toleranceMs: 5_000 })
		expect(result.timeMs).toBeLessThanOrEqual(target)
		expect(target - result.timeMs).toBeLessThanOrEqual(5_000)
	})

	test('rejects when the probe budget runs out before any safe cursor is found', async () => {
		const probe: RelayProbe = async (cursor) => ({ seq: (cursor ?? 1e12) + 1, timeMs: T0 + 1e9 })
		await expect(seekRelayCursorByTime(probe, T0, { maxProbes: 4 })).rejects.toThrow('probe budget')
	})

	test('propagates probe failures', async () => {
		const probe: RelayProbe = async () => {
			throw new Error('relay unreachable')
		}
		await expect(seekRelayCursorByTime(probe, T0)).rejects.toThrow('relay unreachable')
	})
})

describe('OrderedCursorTracker event time', () => {
	test('exposes the relay time of the confirmed cursor', async () => {
		const tracker = new OrderedCursorTracker(10)
		const first = await tracker.reserve(10, '2026-09-30T00:00:00.000Z')
		const second = await tracker.reserve(11, '2026-09-30T00:00:05.000Z')
		expect(tracker.resumableTimeMs).toBe(Date.parse('2026-09-30T00:00:00.000Z'))
		first?.complete()
		second?.complete()
		await tracker.reserve(12, '2026-09-30T00:00:09.000Z')
		expect(tracker.cursor).toBe(11)
		expect(tracker.resumableTimeMs).toBe(Date.parse('2026-09-30T00:00:05.000Z'))
	})

	test('keeps the earlier time when a later sequence has no usable time', async () => {
		const tracker = new OrderedCursorTracker(10)
		;(await tracker.reserve(1, '2026-09-30T00:00:00.000Z'))?.complete()
		;(await tracker.reserve(2, 'not a time'))?.complete()
		await tracker.reserve(3)
		expect(tracker.cursor).toBe(2)
		expect(tracker.resumableTimeMs).toBe(Date.parse('2026-09-30T00:00:00.000Z'))
	})

	test('carries a time across reset and drops it without a cursor', () => {
		const tracker = new OrderedCursorTracker(10)
		tracker.reset(50, T0)
		expect(tracker.resumableTimeMs).toBe(T0)
		tracker.reset(undefined, T0)
		expect(tracker.resumableTimeMs).toBeUndefined()
	})
})

describe('relay failover by time', () => {
	const staleStore = (cursor: number): RelayCursorStore & { reads: number } => {
		const store = {
			reads: 0,
			read: async () => {
				store.reads++
				return { kind: 'found' as const, cursor }
			},
			save: async () => true,
		}
		return store
	}

	test('prefers a time estimate over an old stored checkpoint', async () => {
		const cursors = new RelayCursorCoordinator((service) => service)
		cursors.initialize('primary', 34_076_083_678)
		const store = staleStore(16_276_978_190)
		const seeks: Array<[string, number]> = []
		const activation = await cursors.switchTo('secondary', 34_076_083_678, store, {
			sourceTimeMs: T0,
			seek: async (service, time) => {
				seeks.push([service, time])
				return 16_307_000_000
			},
		})
		expect(activation).toEqual({ cursor: 16_307_000_000, missingCheckpoint: false, source: 'time-estimate' })
		expect(seeks).toEqual([['secondary', T0]])
		expect(store.reads).toBe(0)
		expect(cursors.knownCursor('secondary')).toBe(16_307_000_000)
	})

	test('falls back to the stored checkpoint when the seek fails', async () => {
		const cursors = new RelayCursorCoordinator((service) => service)
		cursors.initialize('primary', 100)
		const failures: unknown[] = []
		const activation = await cursors.switchTo('secondary', 100, staleStore(42), {
			sourceTimeMs: T0,
			seek: async () => {
				throw new Error('relay unreachable')
			},
			onSeekFailure: (error) => failures.push(error),
		})
		expect(activation).toEqual({ cursor: 42, missingCheckpoint: false, source: 'checkpoint' })
		expect(failures).toHaveLength(1)
	})

	test('uses the stored checkpoint when the source time is unknown', async () => {
		const cursors = new RelayCursorCoordinator((service) => service)
		cursors.initialize('primary', 100)
		let seeks = 0
		const activation = await cursors.switchTo('secondary', 100, staleStore(42), {
			seek: async () => {
				seeks++
				return 1
			},
		})
		expect(activation?.source).toBe('checkpoint')
		expect(seeks).toBe(0)
	})

	test('a probed position is always at or before the requested time', async () => {
		const relay = simulatedRelay({ base: 0, oldest: 0, head: 50_000_000, rate: 350 })
		const sourceTime = T0 + 30 * 3600_000
		const cursors = new RelayCursorCoordinator((service) => service)
		cursors.initialize('primary', 1)
		const activation = await cursors.switchTo('secondary', 1, staleStore(0), {
			sourceTimeMs: sourceTime,
			seek: async (_service, time) => (await seekRelayCursorByTime(relay.probe, time)).cursor,
		})
		const resumed: ProbedPosition = await relay.probe(activation?.cursor)
		expect(resumed.timeMs).toBeLessThanOrEqual(sourceTime)
	})
})

describe('StandbyCursorAdvancer', () => {
	const recordingStore = () => {
		const saves: Array<[string, number]> = []
		const store: RelayCursorStore = {
			read: async () => ({ kind: 'missing' }),
			save: async (service, cursor) => {
				saves.push([service, cursor])
				return true
			},
		}
		return { saves, store }
	}

	test('saves each standby relay at the active safe time', async () => {
		const { saves, store } = recordingStore()
		const seeks: Array<[string, number]> = []
		const advancer = new StandbyCursorAdvancer({
			standbyServices: () => ['primary'],
			sourceTimeMs: () => T0,
			seek: async (service, time) => {
				seeks.push([service, time])
				return 34_078_000_000
			},
			store,
			isCurrent: () => true,
		})
		await advancer.tick()
		expect(seeks).toEqual([['primary', T0]])
		expect(saves).toEqual([['primary', 34_078_000_000]])
	})

	test('does nothing without a known source time', async () => {
		const { saves, store } = recordingStore()
		let seeks = 0
		const advancer = new StandbyCursorAdvancer({
			standbyServices: () => ['primary'],
			sourceTimeMs: () => undefined,
			seek: async () => {
				seeks++
				return 1
			},
			store,
			isCurrent: () => true,
		})
		await advancer.tick()
		expect(seeks).toBe(0)
		expect(saves).toEqual([])
	})

	test('discards a result when the active relay changed during the seek', async () => {
		const { saves, store } = recordingStore()
		let current = true
		const advancer = new StandbyCursorAdvancer({
			standbyServices: () => ['primary'],
			sourceTimeMs: () => T0,
			seek: async () => {
				current = false
				return 5
			},
			store,
			isCurrent: () => current,
		})
		await advancer.tick()
		expect(saves).toEqual([])
	})

	test('reports seek failures and keeps going', async () => {
		const { saves, store } = recordingStore()
		const failures: string[] = []
		const advancer = new StandbyCursorAdvancer({
			standbyServices: () => ['down', 'up'],
			sourceTimeMs: () => T0,
			seek: async (service) => {
				if (service === 'down') throw new Error('unreachable')
				return 9
			},
			store,
			isCurrent: () => true,
			onFailure: (service) => failures.push(service),
		})
		await advancer.tick()
		expect(failures).toEqual(['down'])
		expect(saves).toEqual([['up', 9]])
	})

	test('overlapping ticks share one pass', async () => {
		const { store } = recordingStore()
		let seeks = 0
		const advancer = new StandbyCursorAdvancer({
			standbyServices: () => ['primary'],
			sourceTimeMs: () => T0,
			seek: async () => {
				seeks++
				return 1
			},
			store,
			isCurrent: () => true,
		})
		await Promise.all([advancer.tick(), advancer.tick()])
		expect(seeks).toBe(1)
	})
})
