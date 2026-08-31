import { describe, expect, test } from 'bun:test'
import {
	createSingleFlightTask,
	type IntervalScheduler,
	startPeriodicSingleFlightTask,
	stopServerWithGracePeriod,
	type TimeoutScheduler,
} from './lifecycle'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
	let resolve: (value: T | PromiseLike<T>) => void = () => {}
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

describe('lifecycle tasks', () => {
	test('shares concurrent single-flight runs and becomes idle after the pass', async () => {
		const pass = deferred<string>()
		let calls = 0
		const task = createSingleFlightTask(async () => {
			calls++
			return pass.promise
		})

		const first = task.run()
		const second = task.run()
		expect(first).toBe(second)
		await Promise.resolve()
		expect(calls).toBe(1)
		expect(task.isRunning()).toBe(true)

		pass.resolve('done')
		expect(await first).toBe('done')
		await task.waitForIdle()
		expect(task.isRunning()).toBe(false)
	})

	test('clears periodic work and waits for an active pass without overlap', async () => {
		const pass = deferred<void>()
		let calls = 0
		let intervalCallback: (() => void) | undefined
		let clearCalls = 0
		const scheduler: IntervalScheduler = {
			setInterval(callback) {
				intervalCallback = callback
				return 1 as unknown as ReturnType<typeof setInterval>
			},
			clearInterval() {
				clearCalls++
			},
		}
		const task = startPeriodicSingleFlightTask(
			async () => {
				calls++
				return pass.promise
			},
			100,
			() => {},
			scheduler,
		)

		await Promise.resolve()
		expect(calls).toBe(1)
		intervalCallback?.()
		expect(calls).toBe(1)

		let stopped = false
		const stop = task.stop()
		expect(task.stop()).toBe(stop)
		const stopping = stop.then(() => {
			stopped = true
		})
		await Promise.resolve()
		expect(clearCalls).toBe(1)
		expect(stopped).toBe(false)

		pass.resolve()
		await stopping
		intervalCallback?.()
		expect(calls).toBe(1)
	})

	test('keeps a completed graceful shutdown and clears its timeout', async () => {
		const calls: boolean[] = []
		let timeoutCleared = false
		const scheduler: TimeoutScheduler = {
			setTimeout() {
				return 1 as unknown as ReturnType<typeof setTimeout>
			},
			clearTimeout() {
				timeoutCleared = true
			},
		}
		const application = {
			async stop(force = false): Promise<void> {
				calls.push(force)
			},
		}

		expect(await stopServerWithGracePeriod(application, 100, scheduler)).toBe('graceful')
		expect(calls).toEqual([false])
		expect(timeoutCleared).toBe(true)
	})

	test('force-stops active requests after the grace timeout', async () => {
		const gracefulStop = deferred<void>()
		const calls: boolean[] = []
		let timeoutCallback: (() => void) | undefined
		let timeoutCleared = false
		const scheduler: TimeoutScheduler = {
			setTimeout(callback) {
				timeoutCallback = callback
				return 1 as unknown as ReturnType<typeof setTimeout>
			},
			clearTimeout() {
				timeoutCleared = true
			},
		}
		const application = {
			async stop(force = false): Promise<void> {
				calls.push(force)
				if (!force) return gracefulStop.promise
			},
		}

		const stopping = stopServerWithGracePeriod(application, 100, scheduler)
		timeoutCallback?.()
		expect(await stopping).toBe('forced')
		expect(calls).toEqual([false, true])
		expect(timeoutCleared).toBe(true)
		gracefulStop.resolve()
	})
})
