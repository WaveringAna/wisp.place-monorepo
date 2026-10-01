/**
 * One-shot relay position probe: subscribe from a cursor, read the first
 * sequenced frame, and disconnect. Used to map a wall-clock time onto a relay's
 * own sequence space, which differs per relay.
 */

import { decodeAll } from '@atproto/lex-cbor'

export interface RelayPosition {
	/** Sequence of the first event the relay delivers after the requested cursor. */
	seq: number
	/** The relay event's `time` field, as epoch milliseconds. */
	timeMs: number
}

export interface ProbeRelayOptions {
	timeoutMs?: number
	signal?: AbortSignal
}

/**
 * Resolve the first sequenced event at or after `cursor + 1` (the live head
 * when `cursor` is undefined). `#info` frames such as OutdatedCursor are
 * skipped; error frames and timeouts reject.
 */
export function probeRelayPosition(
	service: string,
	cursor: number | undefined,
	options: ProbeRelayOptions = {},
): Promise<RelayPosition> {
	const base = service.replace(/\/$/, '')
	const query = cursor === undefined ? '' : `?cursor=${cursor}`
	const url = `${base}/xrpc/com.atproto.sync.subscribeRepos${query}`
	const timeoutMs = options.timeoutMs ?? 10_000

	return new Promise((resolve, reject) => {
		let settled = false
		const ws = new WebSocket(url)
		ws.binaryType = 'arraybuffer'

		const finish = (error: Error | null, position?: RelayPosition) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			options.signal?.removeEventListener('abort', onAbort)
			try {
				ws.close()
			} catch {}
			if (error) reject(error)
			else resolve(position as RelayPosition)
		}
		const onAbort = () => finish(new Error('Relay probe aborted'))
		const timer = setTimeout(() => finish(new Error(`Relay probe timed out after ${timeoutMs}ms`)), timeoutMs)
		if (options.signal?.aborted) return onAbort()
		options.signal?.addEventListener('abort', onAbort)

		ws.onmessage = (message) => {
			try {
				const [header, body] = [...decodeAll(new Uint8Array(message.data as ArrayBuffer))] as [
					{ op?: number; t?: string },
					Record<string, unknown>,
				]
				if (header?.op === -1) {
					finish(new Error(`Relay error frame: ${String(body?.error)}`))
					return
				}
				const seq = body?.seq
				const timeMs = typeof body?.time === 'string' ? Date.parse(body.time) : Number.NaN
				if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || !Number.isFinite(timeMs)) return
				finish(null, { seq, timeMs })
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)))
			}
		}
		ws.onerror = () => finish(new Error('Relay probe connection error'))
		ws.onclose = () => finish(new Error('Relay probe closed before a sequenced event'))
	})
}
