import { describe, expect, test } from 'bun:test'
import type { HostingDbReadRetryOutcome } from '@wispplace/observability'
import { DEFAULT_RETRY_DELAYS_MS, isTransientConnectionError, retryTransientRead } from './read-retry'

const withCode = (code: string) => Object.assign(new Error(`write ${code} 10.88.0.4:15433`), { code })

const harness = () => {
	const sleeps: number[] = []
	const outcomes: HostingDbReadRetryOutcome[] = []
	return {
		sleeps,
		outcomes,
		options: {
			sleep: async (ms: number) => {
				sleeps.push(ms)
			},
			onOutcome: (outcome: HostingDbReadRetryOutcome) => {
				outcomes.push(outcome)
			},
		},
	}
}

/** A read that fails with each given error in turn, then returns `value`. */
const failingThen = <T>(errors: readonly unknown[], value: T) => {
	let calls = 0
	return {
		calls: () => calls,
		read: async (): Promise<T> => {
			const error = errors[calls++]
			if (error !== undefined) throw error
			return value
		},
	}
}

describe('isTransientConnectionError', () => {
	test('is true only for a connection that died under the read', () => {
		expect(isTransientConnectionError(withCode('CONNECTION_CLOSED'))).toBe(true)
		expect(isTransientConnectionError(withCode('ECONNRESET'))).toBe(true)
	})

	test('is false for shutdown, slow connects, query errors and non-errors', () => {
		for (const error of [
			withCode('CONNECTION_DESTROYED'),
			withCode('CONNECT_TIMEOUT'),
			withCode('42P01'),
			new Error('CONNECTION_CLOSED'),
			'CONNECTION_CLOSED',
			null,
			undefined,
		]) {
			expect(isTransientConnectionError(error)).toBe(false)
		}
	})
})

describe('retryTransientRead', () => {
	test('returns a successful read untouched, without sleeping or recording', async () => {
		const { sleeps, outcomes, options } = harness()
		const source = failingThen([], 'row')

		expect(await retryTransientRead(source.read, options)).toBe('row')
		expect(source.calls()).toBe(1)
		expect(sleeps).toEqual([])
		expect(outcomes).toEqual([])
	})

	test('retries a dropped connection after the first delay and records the recovery', async () => {
		const { sleeps, outcomes, options } = harness()
		const source = failingThen([withCode('CONNECTION_CLOSED')], 'row')

		expect(await retryTransientRead(source.read, { ...options, delaysMs: [5, 9] })).toBe('row')
		expect(source.calls()).toBe(2)
		expect(sleeps).toEqual([5])
		expect(outcomes).toEqual(['recovered'])
	})

	test('keeps retrying through each delay, then returns the read that finally works', async () => {
		const { sleeps, outcomes, options } = harness()
		const source = failingThen([withCode('CONNECTION_CLOSED'), withCode('ECONNRESET')], 'row')

		expect(await retryTransientRead(source.read, { ...options, delaysMs: [5, 9] })).toBe('row')
		expect(source.calls()).toBe(3)
		expect(sleeps).toEqual([5, 9])
		expect(outcomes).toEqual(['recovered'])
	})

	test('gives up when the delays run out, throwing the last error and recording it once', async () => {
		const { sleeps, outcomes, options } = harness()
		const last = withCode('CONNECTION_CLOSED')
		const source = failingThen([withCode('CONNECTION_CLOSED'), withCode('CONNECTION_CLOSED'), last], 'row')

		await expect(retryTransientRead(source.read, { ...options, delaysMs: [5, 9] })).rejects.toBe(last)
		expect(source.calls()).toBe(3)
		expect(sleeps).toEqual([5, 9])
		expect(outcomes).toEqual(['exhausted'])
	})

	test('does not retry any other failure and records nothing', async () => {
		for (const error of [
			withCode('42P01'),
			withCode('CONNECTION_DESTROYED'),
			withCode('CONNECT_TIMEOUT'),
			new Error('boom'),
		]) {
			const { sleeps, outcomes, options } = harness()
			const source = failingThen([error], 'row')

			await expect(retryTransientRead(source.read, options)).rejects.toBe(error)
			expect(source.calls()).toBe(1)
			expect(sleeps).toEqual([])
			expect(outcomes).toEqual([])
		}
	})

	test('a failure that is not a dropped connection after a retry is still thrown, unrecorded', async () => {
		const { outcomes, options } = harness()
		const query = withCode('42P01')
		const source = failingThen([withCode('CONNECTION_CLOSED'), query], 'row')

		await expect(retryTransientRead(source.read, options)).rejects.toBe(query)
		expect(outcomes).toEqual([])
	})

	test('the default retries add at most half a second to a request', () => {
		expect(DEFAULT_RETRY_DELAYS_MS.length).toBeGreaterThan(0)
		expect(DEFAULT_RETRY_DELAYS_MS.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(500)
	})
})
