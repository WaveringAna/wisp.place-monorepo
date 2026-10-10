import type { HostingDbReadRetryOutcome } from '@wispplace/observability'

/**
 * Error codes that mean the socket died under a read: the pooled connection was
 * closed by the database, a proxy or the network before or while the query ran,
 * and a fresh one normally works at once. CONNECTION_DESTROYED (the pool was
 * ended on shutdown) and CONNECT_TIMEOUT (a slow connect, up to 30 s) are left
 * out because retrying either only adds delay.
 */
const TRANSIENT_CONNECTION_CODES: ReadonlySet<string> = new Set(['CONNECTION_CLOSED', 'ECONNRESET'])

export const isTransientConnectionError = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	'code' in error &&
	typeof error.code === 'string' &&
	TRANSIENT_CONNECTION_CODES.has(error.code)

/** Waits before each retry; the sum is the most a request can be held up. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [50, 200]

export interface ReadRetryOptions {
	delaysMs?: readonly number[]
	sleep?: (ms: number) => Promise<void>
	onOutcome?: (outcome: HostingDbReadRetryOutcome) => void
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run an idempotent read, retrying it after a short wait while its connection
 * keeps being dropped. Any other failure is thrown at once. A read that needed
 * retries reports `recovered`, or `exhausted` when the last error is thrown.
 */
export async function retryTransientRead<T>(
	read: () => Promise<T>,
	{ delaysMs = DEFAULT_RETRY_DELAYS_MS, sleep = sleepMs, onOutcome = () => {} }: ReadRetryOptions = {},
): Promise<T> {
	const attempt = async (retriesUsed: number): Promise<T> => {
		try {
			const result = await read()
			if (retriesUsed > 0) onOutcome('recovered')
			return result
		} catch (error) {
			if (!isTransientConnectionError(error)) throw error
			const delayMs = delaysMs[retriesUsed]
			if (delayMs === undefined) {
				onOutcome('exhausted')
				throw error
			}
			await sleep(delayMs)
			return attempt(retriesUsed + 1)
		}
	}
	return attempt(0)
}
