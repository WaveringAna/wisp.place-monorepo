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
