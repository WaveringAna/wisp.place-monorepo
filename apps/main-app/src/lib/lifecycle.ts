export interface SingleFlightTask<T> {
	run(): Promise<T>
	isRunning(): boolean
	waitForIdle(): Promise<void>
}

/**
 * Shares concurrent calls with one active task. Lifecycle callers can stop
 * scheduling new work and wait for the current task without starting another.
 */
export function createSingleFlightTask<T>(task: () => Promise<T>): SingleFlightTask<T> {
	let active: Promise<T> | undefined

	const run = (): Promise<T> => {
		if (active) return active

		const current = Promise.resolve().then(task)
		active = current
		void current.then(
			() => {
				if (active === current) active = undefined
			},
			() => {
				if (active === current) active = undefined
			},
		)
		return current
	}

	const waitForIdle = async (): Promise<void> => {
		while (active) {
			await active.catch(() => undefined)
		}
	}

	return {
		run,
		isRunning: () => active !== undefined,
		waitForIdle,
	}
}

export interface IntervalScheduler {
	setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>
	clearInterval(handle: ReturnType<typeof setInterval>): void
}

const defaultIntervalScheduler: IntervalScheduler = {
	setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
	clearInterval: (handle) => clearInterval(handle),
}

export interface PeriodicSingleFlightTask<T> {
	runNow(): Promise<T> | undefined
	stop(): Promise<void>
	waitForIdle(): Promise<void>
}

/**
 * Starts one immediate task plus periodic runs. A slow pass never overlaps a
 * later tick, and stop clears the interval before waiting for the active pass.
 */
export function startPeriodicSingleFlightTask<T>(
	task: () => Promise<T>,
	intervalMs: number,
	onError: () => void,
	scheduler: IntervalScheduler = defaultIntervalScheduler,
): PeriodicSingleFlightTask<T> {
	const singleFlight = createSingleFlightTask(task)
	let stopped = false
	let stopPromise: Promise<void> | undefined

	const reportError = (): void => {
		try {
			onError()
		} catch {
			// Reporting a background error must not create an unhandled rejection.
		}
	}

	const runNow = (): Promise<T> | undefined => {
		if (stopped || singleFlight.isRunning()) return undefined
		const run = singleFlight.run()
		void run.catch(reportError)
		return run
	}

	const interval = scheduler.setInterval(() => {
		runNow()
	}, intervalMs)
	runNow()

	const stop = (): Promise<void> => {
		if (stopPromise) return stopPromise

		stopped = true
		scheduler.clearInterval(interval)
		stopPromise = singleFlight.waitForIdle()
		return stopPromise
	}

	return { runNow, stop, waitForIdle: singleFlight.waitForIdle }
}

export interface StoppableApplication {
	stop(closeActiveConnections?: boolean): Promise<unknown>
}

export interface TimeoutScheduler {
	setTimeout(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout>
	clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

const defaultTimeoutScheduler: TimeoutScheduler = {
	setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
	clearTimeout: (handle) => clearTimeout(handle),
}

export type ServerStopResult = 'graceful' | 'forced'

/**
 * Stop new requests gracefully. If active requests exceed the bounded grace
 * period, force-close them before dependent clients are shut down.
 */
export async function stopServerWithGracePeriod(
	application: StoppableApplication,
	gracePeriodMs: number,
	scheduler: TimeoutScheduler = defaultTimeoutScheduler,
): Promise<ServerStopResult> {
	let timeout: ReturnType<typeof setTimeout> | undefined
	const gracefulStop = application.stop()
	const timeoutReached = new Promise<false>((resolve) => {
		timeout = scheduler.setTimeout(() => resolve(false), gracePeriodMs)
	})

	try {
		const stoppedGracefully = await Promise.race([gracefulStop.then(() => true), timeoutReached])
		if (stoppedGracefully) return 'graceful'

		// Keep the first stop rejection observed so it cannot become unhandled after force-close.
		void gracefulStop.catch(() => undefined)
		await application.stop(true)
		return 'forced'
	} finally {
		if (timeout !== undefined) scheduler.clearTimeout(timeout)
	}
}
