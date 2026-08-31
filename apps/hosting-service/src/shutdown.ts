export interface StoppableHttpServer {
	stop(closeActiveConnections?: boolean): Promise<void> | void
}

export interface HttpServerStopResult {
	forced: boolean
	gracefulStopFailed: boolean
	forceStopFailed: boolean
}

type GracefulStopState = 'drained' | 'failed' | 'timedOut'

function stopServer(server: StoppableHttpServer, closeActiveConnections: boolean): Promise<void> {
	try {
		return Promise.resolve(server.stop(closeActiveConnections))
	} catch {
		return Promise.reject()
	}
}

function waitForGracefulStop(stopPromise: Promise<void>, gracePeriodMs: number): Promise<GracefulStopState> {
	const timeoutMs = Number.isFinite(gracePeriodMs) ? Math.max(0, Math.floor(gracePeriodMs)) : 0

	return new Promise((resolve) => {
		const timeout = setTimeout(() => resolve('timedOut'), timeoutMs)
		void stopPromise.then(
			() => {
				clearTimeout(timeout)
				resolve('drained')
			},
			() => {
				clearTimeout(timeout)
				resolve('failed')
			},
		)
	})
}

/** Stop accepting work, wait a bounded time for it to drain, then force close it. */
export async function stopHttpServerWithGrace(
	server: StoppableHttpServer,
	gracePeriodMs: number,
): Promise<HttpServerStopResult> {
	const gracefulStop = stopServer(server, false)
	const gracefulStopState = await waitForGracefulStop(gracefulStop, gracePeriodMs)

	if (gracefulStopState === 'drained') {
		return { forced: false, gracefulStopFailed: false, forceStopFailed: false }
	}

	const forceStopFailed = await stopServer(server, true).then(
		() => false,
		() => true,
	)

	return {
		forced: true,
		gracefulStopFailed: gracefulStopState === 'failed',
		forceStopFailed,
	}
}

/** Return one shared promise so repeated signals cannot run shutdown twice. */
export function onceAsync<T>(operation: (value: T) => Promise<void>): (value: T) => Promise<void> {
	let operationPromise: Promise<void> | undefined

	return (value: T) => {
		if (!operationPromise) {
			operationPromise = Promise.resolve().then(() => operation(value))
		}
		return operationPromise
	}
}
