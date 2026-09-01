import { describe, expect, test } from 'bun:test'
import { onceAsync, runWithForceFallback, settleWithTimeout } from './index'

function deferred<T>(): {
	promise: Promise<T>
	resolve(value: T | PromiseLike<T>): void
	reject(reason?: unknown): void
} {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

describe('graceful shutdown primitives', () => {
	test('reports a timeout and consumes a late task rejection', async () => {
		const task = deferred<void>()
		expect((await settleWithTimeout(task.promise, 0)).status).toBe('timed-out')
		task.reject(new Error('late task failure'))
		await Promise.resolve()
	})

	test('shares one operation promise and keeps the first signal', async () => {
		const signals: string[] = []
		const shutdown = onceAsync(async (signal: string) => {
			signals.push(signal)
		})
		const first = shutdown('SIGINT')
		const second = shutdown('SIGTERM')
		expect(second).toBe(first)
		await first
		expect(signals).toEqual(['SIGINT'])
	})

	test('forces cleanup after graceful timeout and preserves cleanup order', async () => {
		const order: string[] = []
		const graceful = deferred<void>()
		const result = await runWithForceFallback(
			() => {
				order.push('graceful')
				return graceful.promise
			},
			() => {
				order.push('force')
			},
			0,
		)
		order.push('cleanup')
		expect(result).toEqual({ forced: true, gracefulStopFailed: false, forceStopFailed: false })
		expect(order).toEqual(['graceful', 'force', 'cleanup'])
		graceful.resolve()
	})

	test('uses force fallback when graceful cleanup rejects and reports force errors', async () => {
		const result = await runWithForceFallback(
			() => Promise.reject(new Error('graceful failed')),
			() => Promise.reject(new Error('force failed')),
			1_000,
		)
		expect(result).toEqual({ forced: true, gracefulStopFailed: true, forceStopFailed: true })
	})
})
