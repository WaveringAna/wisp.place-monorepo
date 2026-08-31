import { describe, expect, test } from 'bun:test'
import { onceAsync, stopHttpServerWithGrace } from './shutdown'

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

describe('HTTP shutdown lifecycle', () => {
	test('stops accepting work before waiting for active requests to drain', async () => {
		const drain = deferred<void>()
		const stopCalls: boolean[] = []
		const server = {
			stop(closeActiveConnections = false): Promise<void> {
				stopCalls.push(closeActiveConnections)
				return closeActiveConnections ? Promise.resolve() : drain.promise
			},
		}

		const stopping = stopHttpServerWithGrace(server, 1_000)
		expect(stopCalls).toEqual([false])

		drain.resolve()
		expect(await stopping).toEqual({ forced: false, gracefulStopFailed: false, forceStopFailed: false })
		expect(stopCalls).toEqual([false])
	})

	test('forces lingering requests after the grace period', async () => {
		const stopCalls: boolean[] = []
		const server = {
			stop(closeActiveConnections = false): Promise<void> {
				stopCalls.push(closeActiveConnections)
				return closeActiveConnections ? Promise.resolve() : new Promise(() => {})
			},
		}

		expect(await stopHttpServerWithGrace(server, 0)).toEqual({
			forced: true,
			gracefulStopFailed: false,
			forceStopFailed: false,
		})
		expect(stopCalls).toEqual([false, true])
	})

	test('forces requests closed when graceful stop fails', async () => {
		const stopCalls: boolean[] = []
		const server = {
			stop(closeActiveConnections = false): Promise<void> {
				stopCalls.push(closeActiveConnections)
				return closeActiveConnections ? Promise.resolve() : Promise.reject(new Error('stop failed'))
			},
		}

		expect(await stopHttpServerWithGrace(server, 1_000)).toEqual({
			forced: true,
			gracefulStopFailed: true,
			forceStopFailed: false,
		})
		expect(stopCalls).toEqual([false, true])
	})

	test('shares one shutdown promise across repeated signals', async () => {
		const complete = deferred<void>()
		const signals: string[] = []
		const shutdown = onceAsync(async (signal: string) => {
			signals.push(signal)
			await complete.promise
		})

		const first = shutdown('SIGINT')
		const second = shutdown('SIGTERM')
		expect(second).toBe(first)

		await Promise.resolve()
		expect(signals).toEqual(['SIGINT'])
		complete.resolve()
		await first
	})
})
