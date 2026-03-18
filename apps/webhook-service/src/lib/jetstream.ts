import { createLogger } from '@wispplace/observability'

const logger = createLogger('webhook-service:jetstream')

export interface JetstreamCommit {
	rev: string
	operation: 'create' | 'update' | 'delete'
	collection: string
	rkey: string
	record?: unknown
	cid?: string
}

export interface JetstreamEvent {
	did: string
	time_us: number
	kind: 'commit' | 'identity' | 'account'
	commit?: JetstreamCommit
}

export interface JetstreamOptions {
	url: string
	wantedDids?: string[]
	wantedCollections?: string[]
	cursor?: number
	onEvent: (event: JetstreamEvent) => void | Promise<void>
	onConnect?: () => void
	onDisconnect?: () => void
	onError?: (err: Error) => void

}

export class JetstreamClient {
	private ws: WebSocket | null = null
	private destroyed = false
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private lastCursor: number | undefined

	constructor(private opts: JetstreamOptions) {
		this.lastCursor = opts.cursor
	}

	start(): void {
		this.connect()
	}

	private buildUrl(cursor?: number): string {
		const url = new URL(this.opts.url)

		for (const did of this.opts.wantedDids ?? []) {
			url.searchParams.append('wantedDids', did)
		}
		for (const col of this.opts.wantedCollections ?? []) {
			url.searchParams.append('wantedCollections', col)
		}
		if (cursor !== undefined) {
			url.searchParams.set('cursor', String(cursor))
		}

		return url.toString()
	}

	private connect(): void {
		if (this.destroyed) return

		const url = this.buildUrl(this.lastCursor)
		logger.info(`Connecting to Jetstream: ${url}`)

		const ws = new WebSocket(url)
		this.ws = ws

		ws.onopen = () => {
			logger.info('Jetstream connected')
			this.opts.onConnect?.()
		}

		ws.onmessage = async (e) => {
			try {
				const event = JSON.parse(e.data as string) as JetstreamEvent
				this.lastCursor = event.time_us
				await this.opts.onEvent(event)
			} catch (err) {
				this.opts.onError?.(err instanceof Error ? err : new Error(String(err)))
			}
		}

		ws.onclose = () => {
			if (this.destroyed) return
			logger.warn('Jetstream disconnected, reconnecting in 3s')
			this.opts.onDisconnect?.()
			this.reconnectTimer = setTimeout(() => this.connect(), 3_000)
		}

		ws.onerror = () => {
			this.opts.onError?.(new Error('Jetstream WebSocket error'))
		}
	}

	get cursor(): number | undefined {
		return this.lastCursor
	}

	destroy(): void {
		this.destroyed = true
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.ws?.close()
		this.ws = null
	}
}
