export type ShutdownSettlement<T> =
	| { readonly status: 'settled'; readonly value: T }
	| { readonly status: 'rejected'; readonly error: unknown }
	| { readonly status: 'timed-out' }

function normalizeTimeout(timeoutMs: number): number {
	return Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0
}

/** Await a task for a bounded interval without leaving a late rejection unhandled. */
export async function settleWithTimeout<T>(
	task: Promise<T> | null | undefined,
	timeoutMs: number,
): Promise<ShutdownSettlement<T>> {
	if (!task) return { status: 'settled', value: undefined as T }
	let timer: ReturnType<typeof setTimeout> | undefined
	const taskResult = task.then<ShutdownSettlement<T>, ShutdownSettlement<T>>(
		(value) => ({ status: 'settled', value }),
		(error) => ({ status: 'rejected', error }),
	)
	const timeout = new Promise<ShutdownSettlement<T>>((resolve) => {
		timer = setTimeout(() => resolve({ status: 'timed-out' }), normalizeTimeout(timeoutMs))
	})
	try {
		return await Promise.race([taskResult, timeout])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

/** Await work only until a process-wide deadline; consume any late rejection. */
export function settleBeforeDeadline<T>(
	task: Promise<T> | null | undefined,
	deadline: number,
): Promise<ShutdownSettlement<T>> {
	if (!task) return Promise.resolve({ status: 'settled', value: undefined as T })
	const remaining = Math.max(0, deadline - Date.now())
	if (remaining === 0) {
		void task.catch(() => undefined)
		return Promise.resolve({ status: 'timed-out' })
	}
	return settleWithTimeout(task, remaining)
}

/** Keep a positive timeout when passing a shared process deadline to a bounded operation. */
export function remainingShutdownTimeout(deadline: number): number {
	return Math.max(1, deadline - Date.now())
}

/** Return one promise so repeated signals cannot run the operation twice. */
export function onceAsync<T, R>(operation: (value: T) => R | PromiseLike<R>): (value: T) => Promise<R> {
	let operationPromise: Promise<R> | undefined
	return (value: T) => {
		if (!operationPromise) operationPromise = Promise.resolve().then(() => operation(value))
		return operationPromise
	}
}

export interface ForceFallbackResult {
	forced: boolean
	gracefulStopFailed: boolean
	forceStopFailed: boolean
}

function invoke<T>(operation: () => T | PromiseLike<T>): Promise<T> {
	try {
		return Promise.resolve(operation())
	} catch (error) {
		return Promise.reject(error)
	}
}

/** Run graceful cleanup, then force cleanup when it fails or exceeds its grace period. */
export async function runWithForceFallback(
	gracefulStop: () => void | PromiseLike<void>,
	forceStop: () => void | PromiseLike<void>,
	gracePeriodMs: number,
): Promise<ForceFallbackResult> {
	const graceful = await settleWithTimeout(invoke(gracefulStop), gracePeriodMs)
	if (graceful.status === 'settled') return { forced: false, gracefulStopFailed: false, forceStopFailed: false }
	return {
		forced: true,
		gracefulStopFailed: graceful.status === 'rejected',
		forceStopFailed: await invoke(forceStop).then(
			() => false,
			() => true,
		),
	}
}
