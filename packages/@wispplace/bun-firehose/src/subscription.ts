/**
 * Bun-compatible AT Protocol subscription client
 * Uses Bun's native WebSocket instead of @atproto/ws-client
 */

import { decodeAll } from '@atproto/lex-cbor'
import { isPlainObject } from '@atproto/lex-data'
import { MessageQueue } from './queue'

// Frame types from AT Protocol
const FrameType = {
	Message: 1,
	Error: -1,
} as const

interface FrameHeader {
	op: number
	t?: string
}

interface ErrorFrameBody {
	error: string
	message?: string
}

export function decodeFrame(bytes: Uint8Array): { header: FrameHeader; body: unknown } {
	const decoded = decodeAll(bytes)[Symbol.iterator]()
	const header = decoded.next()
	const body = decoded.next()
	if (header.done || body.done) {
		throw new Error('Invalid frame: missing header or body')
	}
	// Consume the remainder so malformed trailing CBOR still fails exactly as
	// it did when decodeAll's result was spread into an array.
	while (!decoded.next().done) {}
	return { header: header.value as unknown as FrameHeader, body: body.value }
}

export interface BunSubscriptionOptions<T> {
	service: string
	method: string
	signal?: AbortSignal
	validate: (obj: unknown) => T | undefined
	getParams?: () => Record<string, unknown> | Promise<Record<string, unknown> | undefined> | undefined
	onReconnectError?: (error: unknown, n: number, initialSetup: boolean) => void
	onConnect?: () => void
	onDisconnect?: () => void
	maxReconnectSeconds?: number
	/**
	 * Force reconnect if no messages received within this many ms (default: 15000 = 15s). `null`
	 * says silence is normal for this source (a quiet local PDS): liveness is then checked with
	 * websocket ping/pong instead, and pongs never count as messages.
	 */
	maxSilenceMs?: number | null
	/** Ping interval when `maxSilenceMs` is null (default: 5000) */
	heartbeatIntervalMs?: number
	/** How long a ping may go unanswered before the connection is dropped (default: 5000) */
	heartbeatTimeoutMs?: number
}

type PingWebSocket = WebSocket & { ping(data: string): unknown }

export class BunSubscription<T = unknown> {
	private ws: WebSocket | null = null
	private reconnectAttempts = 0
	private aborted = false

	constructor(public opts: BunSubscriptionOptions<T>) {
		if (opts.signal) {
			opts.signal.addEventListener('abort', () => {
				this.aborted = true
				this.ws?.close()
			})
		}
	}

	private async getUrl(): Promise<string> {
		const params = (await this.opts.getParams?.()) ?? {}
		const query = encodeQueryParams(params)
		const base = this.opts.service.replace(/\/$/, '')
		return `${base}/xrpc/${this.opts.method}${query ? `?${query}` : ''}`
	}

	private getReconnectDelay(): number {
		const maxSeconds = this.opts.maxReconnectSeconds ?? 64
		const seconds = Math.min(2 ** this.reconnectAttempts, maxSeconds)
		return seconds * 1000
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<T> {
		const maxSilenceMs = this.opts.maxSilenceMs === undefined ? 15_000 : this.opts.maxSilenceMs

		while (!this.aborted) {
			let silenceTimer: ReturnType<typeof setTimeout> | null = null

			try {
				const url = await this.getUrl()

				// Create a queue for messages
				const messageQueue = new MessageQueue<Uint8Array>()
				let resolveMessage: (() => void) | null = null
				let wsError: Error | null = null
				let wsOpen = false
				let wsClosed = false

				const dropSilentConnection = (reason: string) => {
					if (!wsClosed && !this.aborted) {
						console.warn(`[BunSubscription] ${reason}, forcing reconnect`)
						wsClosed = true
						this.ws?.close()
						resolveMessage?.()
					}
				}

				const resetSilenceTimer = () => {
					if (maxSilenceMs === null) return
					if (silenceTimer) clearTimeout(silenceTimer)
					silenceTimer = setTimeout(() => dropSilentConnection(`No messages for ${maxSilenceMs / 1000}s`), maxSilenceMs)
				}

				let pingNonce: string | undefined
				const scheduleHeartbeat = () => {
					if (silenceTimer) clearTimeout(silenceTimer)
					silenceTimer = setTimeout(() => {
						pingNonce = crypto.randomUUID()
						silenceTimer = setTimeout(() => dropSilentConnection('No pong'), this.opts.heartbeatTimeoutMs ?? 5_000)
						try {
							;(this.ws as PingWebSocket).ping(pingNonce)
						} catch {
							dropSilentConnection('Ping failed')
						}
					}, this.opts.heartbeatIntervalMs ?? 5_000)
				}

				this.ws = new WebSocket(url)
				this.ws.binaryType = 'arraybuffer'

				this.ws.addEventListener('open', () => {
					wsOpen = true
					this.reconnectAttempts = 0
					this.opts.onConnect?.()
					if (maxSilenceMs === null) scheduleHeartbeat()
					else resetSilenceTimer()
				})

				this.ws.addEventListener('pong', (event) => {
					if (pingNonce === undefined || decodePong((event as MessageEvent).data) !== pingNonce) return
					pingNonce = undefined
					scheduleHeartbeat()
				})

				this.ws.addEventListener('message', (event) => {
					const data = event.data
					if (data instanceof ArrayBuffer) {
						messageQueue.push(new Uint8Array(data))
						resetSilenceTimer()
						resolveMessage?.()
					}
				})

				this.ws.addEventListener('error', (_event) => {
					wsError = new Error('WebSocket error')
				})

				this.ws.addEventListener('close', () => {
					wsClosed = true
					this.opts.onDisconnect?.()
					resolveMessage?.()
				})

				// Wait for open or error
				while (!wsOpen && !wsError && !wsClosed) {
					await new Promise<void>((resolve) => {
						resolveMessage = resolve
						setTimeout(resolve, 100)
					})
				}

				if (wsError) {
					throw wsError
				}

				// Process messages
				while (!this.aborted && !wsClosed) {
					// Wait for message if queue is empty
					while (messageQueue.length === 0 && !wsClosed && !this.aborted) {
						await new Promise<void>((resolve) => {
							resolveMessage = resolve
						})
					}

					if (wsClosed || this.aborted) break

					const bytes = messageQueue.shift()
					if (!bytes) continue

					try {
						const { header, body } = decodeFrame(bytes)

						if (header.op === FrameType.Error) {
							const errorBody = body as ErrorFrameBody
							throw new Error(`Subscription error: ${errorBody.error} - ${errorBody.message || ''}`)
						}

						if (header.op === FrameType.Message) {
							const t = header.t
							const typedBody = isPlainObject(body)
								? t !== undefined
									? { ...body, $type: t.startsWith('#') ? this.opts.method + t : t }
									: body
								: undefined

							const result = this.opts.validate(typedBody)
							if (result !== undefined) {
								yield result
							}
						}
					} catch (err) {
						// Log decode errors but continue
						console.error('Frame decode error:', err)
					}
				}

				// Clean up
				if (silenceTimer) clearTimeout(silenceTimer)
				this.ws?.close()
				this.ws = null

				if (this.aborted) break

				// Reconnect
				this.reconnectAttempts++
				const delay = this.getReconnectDelay()
				this.opts.onReconnectError?.(new Error('Connection closed'), this.reconnectAttempts, false)
				await new Promise((resolve) => setTimeout(resolve, delay))
			} catch (err) {
				if (silenceTimer) clearTimeout(silenceTimer)
				this.ws?.close()
				this.ws = null

				if (this.aborted) break

				this.reconnectAttempts++
				const delay = this.getReconnectDelay()
				this.opts.onReconnectError?.(err, this.reconnectAttempts, this.reconnectAttempts === 1)
				await new Promise((resolve) => setTimeout(resolve, delay))
			}
		}
	}

	close() {
		this.aborted = true
		this.ws?.close()
	}
}

function decodePong(data: unknown): string | undefined {
	if (typeof data === 'string') return data
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
	if (ArrayBuffer.isView(data))
		return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
	return undefined
}

function encodeQueryParams(obj: Record<string, unknown>): string {
	const params = new URLSearchParams()
	for (const [key, value] of Object.entries(obj)) {
		const encoded = encodeQueryParam(value)
		if (Array.isArray(encoded)) {
			for (const enc of encoded) params.append(key, enc)
		} else if (encoded !== '') {
			params.set(key, encoded)
		}
	}
	return params.toString()
}

function encodeQueryParam(value: unknown): string | string[] {
	if (typeof value === 'string') return value
	if (typeof value === 'number') return value.toString()
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	if (value === undefined || value === null) return ''
	if (value instanceof Date) return value.toISOString()
	if (Array.isArray(value)) return value.flatMap(encodeQueryParam)
	throw new Error(`Cannot encode ${typeof value} into query params`)
}
