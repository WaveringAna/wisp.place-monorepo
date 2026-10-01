export interface RevalidationLoopState {
	running: boolean
	hasRedisClient: boolean
	hasLoop: boolean
}

/** Keep liveness stable during a supervised reconnect without claiming readiness. */
export function resolveRevalidationHealth(
	workerExpected: boolean,
	configured: boolean,
	state: RevalidationLoopState,
): { live: boolean; ready: boolean; reconnecting: boolean } {
	if (!workerExpected || !configured) return { live: true, ready: true, reconnecting: false }
	const live = state.running && state.hasLoop
	const ready = live && state.hasRedisClient
	return { live, ready, reconnecting: live && !state.hasRedisClient }
}

export interface IngestHealthInput {
	draining: boolean
	standbyHealthy: boolean
	workerExpected: boolean
	firehose: { healthy: boolean; ready: boolean }
	revalidation: { live: boolean; ready: boolean }
}

/**
 * Liveness (HTTP status) ignores replay lag so a catching-up worker is never
 * restarted mid-replay; only readiness is withheld until it is caught up.
 */
export function resolveIngestHealth(input: IngestHealthInput): { healthy: boolean; ready: boolean } {
	const activeLive = input.workerExpected && input.firehose.healthy && input.revalidation.live
	const activeReady = activeLive && input.revalidation.ready && input.firehose.ready
	return {
		healthy: !input.draining && (input.standbyHealthy || activeLive),
		ready: !input.draining && activeReady,
	}
}
