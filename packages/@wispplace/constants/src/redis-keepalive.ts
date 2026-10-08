/**
 * The Redis path through haproxy closes connections idle for 180 s
 * (`timeout client` / `timeout server`). TCP keepalive does not reset those
 * application timeouts, so a client that can sit idle must send a command.
 */
export const REDIS_KEEPALIVE_INTERVAL_MS = 60_000

/** Schedules a repeating callback and returns its cancel function. */
export type RedisKeepaliveScheduler = (callback: () => void, intervalMs: number) => () => void

export interface RedisKeepaliveOptions {
	intervalMs?: number
	schedule?: RedisKeepaliveScheduler
	/** Called with a failed ping; the client's own reconnect handles recovery. */
	onError?: (error: unknown) => void
}

// The keepalive must never hold the event loop open during shutdown.
const scheduleUnrefInterval: RedisKeepaliveScheduler = (callback, intervalMs) => {
	const timer = setInterval(callback, intervalMs)
	timer.unref()
	return () => clearInterval(timer)
}

/**
 * Send `ping` every interval so a proxy idle timeout never cuts the connection.
 * `ping` returns undefined to skip a tick (e.g. while the client reconnects);
 * a tick is also skipped while the previous ping is still outstanding.
 * Do not use on a subscriber-mode connection unless its client accepts PING there.
 *
 * @returns stop function; idempotent
 */
export function startRedisKeepalive(
	ping: () => PromiseLike<unknown> | undefined,
	{ intervalMs = REDIS_KEEPALIVE_INTERVAL_MS, schedule = scheduleUnrefInterval, onError }: RedisKeepaliveOptions = {},
): () => void {
	let inFlight = false
	return schedule(() => {
		if (inFlight) return
		let pending: PromiseLike<unknown> | undefined
		try {
			pending = ping()
		} catch (error) {
			onError?.(error)
			return
		}
		if (!pending) return
		inFlight = true
		Promise.resolve(pending)
			.catch((error: unknown) => onError?.(error))
			.finally(() => {
				inFlight = false
			})
	}, intervalMs)
}
