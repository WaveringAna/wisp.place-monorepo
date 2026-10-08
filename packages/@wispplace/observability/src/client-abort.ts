/**
 * nginx's "client closed request" status: no response reaches the client, but
 * route metrics still need a status that is neither success nor server error.
 */
export const CLIENT_CLOSED_REQUEST_STATUS = 499

/**
 * Whether `error` is the abort caused by the client going away mid-request:
 * an AbortError while the request's own signal is aborted. An AbortError with
 * a live request signal (for example an upstream or S3 timeout) is a real failure.
 */
export function isClientAbort(error: unknown, signal: AbortSignal | undefined): boolean {
	if (!signal?.aborted) return false
	if (error === signal.reason) return true
	return (error instanceof Error || error instanceof DOMException) && error.name === 'AbortError'
}
