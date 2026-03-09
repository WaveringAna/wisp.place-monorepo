/**
 * Bun-compatible AT Protocol subscription client
 * Uses Bun's native WebSocket instead of @atproto/ws-client
 */

import { decodeAll } from '@atproto/lex-cbor'
import { isPlainObject } from '@atproto/lex-data'

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

function decodeFrame(bytes: Uint8Array): { header: FrameHeader; body: unknown } {
	const decoded = [...decodeAll(bytes)]
	if (decoded.length < 2) {
		throw new Error('Invalid frame: missing header or body')
	}
	const [header, body] = decoded as [FrameHeader, unknown]
	return { header, body }
}

export interface BunSubscriptionOptions<T> {
	service: string
	method: string
	signal?: AbortSignal
	validate: (obj: unknown) => T | undefined
	getParams?: () => Record<string, unknown> | Promise<Record<string, unknown> | undefined> | undefined
	onReconnectError?: (error: unknown, n: number, initialSetup: boolean) => void
	maxReconnectSeconds?: number
}

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
		while (!this.aborted) {
			try {
				const url = await this.getUrl()

				// Create a queue for messages
				const messageQueue: Uint8Array[] = []
				let resolveMessage: (() => void) | null = null
				let wsError: Error | null = null
				let wsOpen = false
				let wsClosed = false

				this.ws = new WebSocket(url)
				this.ws.binaryType = 'arraybuffer'

				this.ws.addEventListener('open', () => {
					wsOpen = true
					this.reconnectAttempts = 0
				})

				this.ws.addEventListener('message', (event) => {
					const data = event.data
					if (data instanceof ArrayBuffer) {
						messageQueue.push(new Uint8Array(data))
						resolveMessage?.()
					}
				})

				this.ws.addEventListener('error', (_event) => {
					wsError = new Error('WebSocket error')
				})

				this.ws.addEventListener('close', () => {
					wsClosed = true
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
				this.ws?.close()
				this.ws = null

				if (this.aborted) break

				// Reconnect
				this.reconnectAttempts++
				const delay = this.getReconnectDelay()
				this.opts.onReconnectError?.(new Error('Connection closed'), this.reconnectAttempts, false)
				await new Promise((resolve) => setTimeout(resolve, delay))
			} catch (err) {
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
