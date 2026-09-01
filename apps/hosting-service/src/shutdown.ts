import { onceAsync, runWithForceFallback } from '@wispplace/graceful-shutdown'

export { onceAsync }

export interface StoppableHttpServer {
	stop(closeActiveConnections?: boolean): Promise<void> | void
}

export interface HttpServerStopResult {
	forced: boolean
	gracefulStopFailed: boolean
	forceStopFailed: boolean
}

/** Stop accepting work, wait a bounded time for it to drain, then force close it. */
export function stopHttpServerWithGrace(
	server: StoppableHttpServer,
	gracePeriodMs: number,
): Promise<HttpServerStopResult> {
	return runWithForceFallback(
		() => server.stop(false),
		() => server.stop(true),
		gracePeriodMs,
	)
}
