import { describe, expect, test } from 'bun:test'
import { type CasGcJobDependencies, resolveCasGcConfig, runCollectionTick, runReconcileTick } from './cas-gc-job'

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
