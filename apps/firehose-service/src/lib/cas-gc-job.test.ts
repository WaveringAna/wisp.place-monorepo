import { describe, expect, test } from 'bun:test'
import {
	type CasGcClock,
	type CasGcJob,
	type CasGcJobDependencies,
	casGcJobs,
	createCasGcScheduler,
	resolveCasGcConfig,
	runCollectionTick,
	runReconcileTick,
} from './cas-gc-job'

describe('resolveCasGcConfig', () => {
	test('defaults to a day of grace, hourly collection and daily reconcile', () => {
		expect(resolveCasGcConfig({})).toMatchObject({
			graceSeconds: 86_400,
			collectIntervalMs: 3_600_000,
			reconcileIntervalMs: 86_400_000,
		})
	})

	test('never lets a bad value shorten the grace period below an hour', () => {
		for (const raw of ['0', '-5', '59', '3599', 'soon', '', '1e3']) {
			expect(resolveCasGcConfig({ CAS_GC_GRACE_SECONDS: raw }).graceSeconds).toBe(86_400)
		}
		expect(resolveCasGcConfig({ CAS_GC_GRACE_SECONDS: '3600' }).graceSeconds).toBe(3_600)
		expect(resolveCasGcConfig({ CAS_GC_GRACE_SECONDS: `${365 * 86_400}` }).graceSeconds).toBe(86_400)
	})

	test('bounds the interval and batch size', () => {
		expect(resolveCasGcConfig({ CAS_GC_INTERVAL_MS: '10' }).collectIntervalMs).toBe(3_600_000)
		expect(resolveCasGcConfig({ CAS_GC_INTERVAL_MS: '120000' }).collectIntervalMs).toBe(120_000)
		expect(resolveCasGcConfig({ CAS_GC_BATCH: '0' }).batch).toBe(500)
		expect(resolveCasGcConfig({ CAS_GC_BATCH: '100000' }).batch).toBe(500)
	})
})

function deps(overrides: Partial<CasGcJobDependencies> = {}): CasGcJobDependencies {
	return {
		collect: async () => ({ deleted: 0, skipped: 0, failed: 0 }),
		reconcile: async () => ({ repaired: 0, raced: 0 }),
		...overrides,
	}
}

const config = resolveCasGcConfig({})

describe('runCollectionTick', () => {
	test('keeps going while passes are full and stops at the first short one', async () => {
		const handled = [config.batch, config.batch, 3]
		let calls = 0

		const result = await runCollectionTick(
			config,
			deps({ collect: async () => ({ deleted: handled[calls++] ?? 0, skipped: 0, failed: 0 }) }),
		)

		expect(calls).toBe(3)
		expect(result).toMatchObject({ passes: 3, deleted: 2 * config.batch + 3 })
	})

	test('bounds the passes in one tick', async () => {
		let calls = 0

		await runCollectionTick(
			config,
			deps({
				collect: async () => {
					calls++
					return { deleted: config.batch, skipped: 0, failed: 0 }
				},
			}),
		)

		expect(calls).toBe(config.maxPassesPerTick)
	})

	test('stops when the same objects keep failing, instead of spinning on them', async () => {
		let calls = 0

		const result = await runCollectionTick(
			config,
			deps({
				collect: async () => {
					calls++
					return { deleted: 0, skipped: 0, failed: config.batch }
				},
			}),
		)

		expect(calls).toBe(1)
		expect(result.failed).toBe(config.batch)
	})

	test('stops promptly when aborted', async () => {
		const controller = new AbortController()
		let calls = 0

		await runCollectionTick(
			config,
			deps({
				collect: async () => {
					calls++
					controller.abort()
					return { deleted: config.batch, skipped: 0, failed: 0 }
				},
			}),
			controller.signal,
		)

		expect(calls).toBe(1)
	})

	test('reports a failing pass without throwing', async () => {
		const result = await runCollectionTick(
			config,
			deps({
				collect: async () => {
					throw new Error('database unavailable')
				},
			}),
		)

		expect(result).toMatchObject({ passes: 0, errored: true })
	})
})

describe('runReconcileTick', () => {
	test('repeats while it keeps repairing and stops once a pass finds nothing', async () => {
		const repaired = [4, 2, 0]
		let calls = 0

		const result = await runReconcileTick(
			config,
			deps({ reconcile: async () => ({ repaired: repaired[calls++] ?? 0, raced: 0 }) }),
		)

		expect(calls).toBe(3)
		expect(result).toMatchObject({ passes: 3, repaired: 6 })
	})

	test('does not loop on counts that only raced with live updates', async () => {
		let calls = 0

		await runReconcileTick(
			config,
			deps({
				reconcile: async () => {
					calls++
					return { repaired: 0, raced: 5 }
				},
			}),
		)

		expect(calls).toBe(1)
	})

	test('bounds the passes and reports an error without throwing', async () => {
		let calls = 0
		await runReconcileTick(
			config,
			deps({
				reconcile: async () => {
					calls++
					return { repaired: 1, raced: 0 }
				},
			}),
		)
		expect(calls).toBe(config.maxPassesPerTick)

		const failed = await runReconcileTick(
			config,
			deps({
				reconcile: async () => {
					throw new Error('boom')
				},
			}),
		)
		expect(failed.errored).toBe(true)
	})
})

function fakeClock() {
	const pending = new Map<number, { callback: () => void; delayMs: number }>()
	let next = 0
	let cleared = 0
	const clock: CasGcClock = {
		set(callback, delayMs) {
			pending.set(++next, { callback, delayMs })
			return next
		},
		clear(handle) {
			cleared++
			pending.delete(handle as number)
		},
	}
	return {
		clock,
		pending,
		get cleared() {
			return cleared
		},
		/** Fire every timer that is due now, all in the same turn, like timers created together with one delay. */
		fireAll() {
			const due = [...pending.values()]
			pending.clear()
			for (const { callback } of due) callback()
		},
	}
}

function deferred<T = Record<string, unknown>>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve
		reject = onReject
	})
	return { promise, resolve, reject }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function job(name: string, run: CasGcJob['run'], intervalMs = 1_000): CasGcJob {
	return { name, intervalMs, run }
}

function watch(promise: Promise<unknown>) {
	const state = { settled: false }
	promise.then(
		() => {
			state.settled = true
		},
		() => {
			state.settled = true
		},
	)
	return state
}

describe('createCasGcScheduler', () => {
	test('stop waits for a slow job even when a simultaneous one finishes first', async () => {
		const timers = fakeClock()
		const scheduler = createCasGcScheduler(0, timers.clock)
		const slow = deferred()
		let signal: AbortSignal | undefined
		scheduler.start([
			job('slow', (own) => {
				signal = own
				return slow.promise
			}),
			job('fast', async () => ({})),
		])

		timers.fireAll()
		await settle()
		const stopped = watch(scheduler.stop())
		await settle()

		expect(signal?.aborted).toBe(true)
		expect(stopped.settled).toBe(false)
		slow.resolve({})
		await settle()
		expect(stopped.settled).toBe(true)
	})

	test('a rejected job neither ends the drain early nor stops its own schedule', async () => {
		const timers = fakeClock()
		const scheduler = createCasGcScheduler(0, timers.clock)
		const slow = deferred()
		scheduler.start([
			job('slow', () => slow.promise),
			job(
				'broken',
				async () => {
					throw new Error('boom')
				},
				5_000,
			),
		])

		timers.fireAll()
		await settle()
		expect([...timers.pending.values()].map((timer) => timer.delayMs)).toEqual([5_000])

		const stopped = watch(scheduler.stop())
		await settle()
		expect(stopped.settled).toBe(false)
		slow.resolve({})
		await settle()
		expect(stopped.settled).toBe(true)
		expect(timers.pending.size).toBe(0)
	})

	test('a restart does not run new work until the stopped generation has drained', async () => {
		const timers = fakeClock()
		const scheduler = createCasGcScheduler(0, timers.clock)
		const old = deferred()
		const events: string[] = []
		scheduler.start([
			job('old', async () => {
				events.push('old:start')
				await old.promise
				events.push('old:end')
				return {}
			}),
		])
		timers.fireAll()
		await settle()

		const firstStop = watch(scheduler.stop())
		scheduler.start([
			job('new', async () => {
				events.push('new:start')
				return {}
			}),
		])
		timers.fireAll()
		await settle()
		expect(events).toEqual(['old:start'])

		// Stopping again must not certify a drain the first stop has not reached.
		const secondStop = watch(scheduler.stop())
		await settle()
		expect(firstStop.settled).toBe(false)
		expect(secondStop.settled).toBe(false)

		old.resolve({})
		await settle()
		expect(firstStop.settled).toBe(true)
		expect(secondStop.settled).toBe(true)
		expect(events).toEqual(['old:start', 'old:end'])
	})

	test('restarted work runs once the previous generation drains', async () => {
		const timers = fakeClock()
		const scheduler = createCasGcScheduler(0, timers.clock)
		const old = deferred()
		const events: string[] = []
		scheduler.start([job('old', () => old.promise)])
		timers.fireAll()
		await settle()

		const stopped = scheduler.stop()
		scheduler.start([
			job('new', async () => {
				events.push('new')
				return {}
			}),
		])
		timers.fireAll()
		await settle()
		expect(events).toEqual([])

		old.resolve({})
		await stopped
		await settle()
		expect(events).toEqual(['new'])
		await scheduler.stop()
	})

	test('keeps one live timer per job instead of every timer that has fired', async () => {
		const timers = fakeClock()
		const scheduler = createCasGcScheduler(0, timers.clock)
		let runs = 0
		scheduler.start([job('a', async () => ({ run: ++runs })), job('b', async () => ({ run: ++runs }))])

		for (let tick = 0; tick < 5; tick++) {
			timers.fireAll()
			await settle()
		}
		expect(runs).toBe(10)
		expect(timers.pending.size).toBe(2)

		await scheduler.stop()
		expect(timers.cleared).toBe(2)
		expect(timers.pending.size).toBe(0)
	})

	test('first runs after the start delay, then repeats on each job interval, and start is idempotent', async () => {
		const timers = fakeClock()
		const scheduler = createCasGcScheduler(900_000, timers.clock)
		const jobs = casGcJobs({ ...config, collectIntervalMs: 60_000, reconcileIntervalMs: 3_600_000 }, deps())
		scheduler.start(jobs)
		scheduler.start(jobs)
		expect([...timers.pending.values()].map((timer) => timer.delayMs)).toEqual([900_000, 900_000])

		timers.fireAll()
		await settle()
		expect([...timers.pending.values()].map((timer) => timer.delayMs)).toEqual([60_000, 3_600_000])
		await scheduler.stop()
	})
})
