import { isCanonicalWebhookDid } from '@wispplace/atproto-utils'
import { createLogger } from '@wispplace/observability'
import { config } from '../config'
import {
	MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES,
	MAX_JETSTREAM_WANTED_COLLECTIONS,
	MAX_JETSTREAM_WANTED_DIDS,
} from './admission'
import { isValidAtprotoRevision } from './atproto-revision'

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
	wantedDids?: readonly string[]
	wantedCollections?: readonly string[]
	cursor?: number
	/** Resolves only after all durable work for this event is complete. */
	onEvent: (event: JetstreamEvent) => void | Promise<void>
	/** Runs in source order after onEvent, usually to persist the stream cursor. */
	onAcknowledged?: (event: JetstreamEvent) => void | Promise<void>
	onConnect?: () => void
	onDisconnect?: () => void
	onError?: (err: Error) => void
	maxQueue?: number
	concurrency?: number
	maxEventBytes?: number
	reconnectMinMs?: number
	reconnectMaxMs?: number
	reconnectMaxExponent?: number
	/** How long a recovering stream may go without durable progress before it is stalled. */
	progressStaleMs?: number
}

interface QueuedEvent {
	event: JetstreamEvent
	state: 'queued' | 'running' | 'complete'
}

function isStableDid(value: string): boolean {
	return isCanonicalWebhookDid(value)
}

/** A recovering stream stays healthy only while it keeps acknowledging work. */
const DEFAULT_PROGRESS_STALE_MS = 60_000

const COLLECTION_RE = /^[A-Za-z0-9.-]{1,253}$/
const RKEY_RE = /^[A-Za-z0-9._~:%@+-]{1,512}$/

function callback(callback: (() => void) | undefined): void {
	try {
		callback?.()
	} catch {
		// Lifecycle observers cannot be allowed to break cursor handling.
	}
}

function report(options: JetstreamOptions, err: Error): void {
	try {
		options.onError?.(err)
	} catch {
		// Error observers are diagnostic only.
	}
}

function validCursor(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Validate a relay message before it can influence a durable cursor. */
export function parseJetstreamEvent(value: unknown): JetstreamEvent | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const event = value as Record<string, unknown>
	const did = event.did
	const timeUs = event.time_us
	const kind = event.kind
	if (typeof did !== 'string' || !isStableDid(did)) return null
	if (!validCursor(timeUs)) return null
	if (kind !== 'commit' && kind !== 'identity' && kind !== 'account') return null

	if (kind !== 'commit') {
		return { did, time_us: timeUs, kind }
	}
	if (!event.commit || typeof event.commit !== 'object' || Array.isArray(event.commit)) return null
	const commit = event.commit as Record<string, unknown>
	if (
		typeof commit.rev !== 'string' ||
		!isValidAtprotoRevision(commit.rev) ||
		(commit.operation !== 'create' && commit.operation !== 'update' && commit.operation !== 'delete') ||
		typeof commit.collection !== 'string' ||
		!COLLECTION_RE.test(commit.collection) ||
		typeof commit.rkey !== 'string' ||
		!RKEY_RE.test(commit.rkey) ||
		(commit.operation !== 'delete' && commit.record === undefined) ||
		(commit.cid !== undefined && (typeof commit.cid !== 'string' || commit.cid.length === 0 || commit.cid.length > 512))
	) {
		return null
	}
	return {
		did,
		time_us: timeUs,
		kind: 'commit',
		commit: {
			rev: commit.rev,
			operation: commit.operation,
			collection: commit.collection,
			rkey: commit.rkey,
			...(commit.record === undefined ? {} : { record: commit.record }),
			...(commit.cid === undefined ? {} : { cid: commit.cid }),
		},
	}
}

/** A credential-free, query-free relay identity for cursors and delivery identities. */
export function normalizeRelayIdentity(value: string): string {
	const url = new URL(value)
	url.username = ''
	url.password = ''
	url.search = ''
	url.hash = ''
	const pathname = url.pathname.replace(/\/+$/, '') || '/'
	return `${url.protocol}//${url.host.toLowerCase()}${pathname}`
}

function messageText(data: unknown, maxBytes: number): string | null {
	if (typeof data === 'string') return Buffer.byteLength(data) <= maxBytes ? data : null
	if (data instanceof ArrayBuffer) {
		if (data.byteLength > maxBytes) return null
		return new TextDecoder().decode(data)
	}
	if (ArrayBuffer.isView(data)) {
		if (data.byteLength > maxBytes) return null
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
	}
	return null
}

/** Build and hard-limit the exact encoded relay subscription URL. */
export function buildJetstreamSubscriptionUrl(
	options: Pick<JetstreamOptions, 'url' | 'wantedDids' | 'wantedCollections'>,
	cursor?: number,
): string {
	const url = new URL(options.url)
	// Only this client owns subscription query parameters. Never preserve a
	// caller-supplied cursor/filter that could broaden replay scope.
	url.search = ''
	let didCount = 0
	for (const did of options.wantedDids ?? []) {
		if (!isStableDid(did)) continue
		if (++didCount > MAX_JETSTREAM_WANTED_DIDS) throw new Error('Jetstream wanted-DID limit exceeded')
		url.searchParams.append('wantedDids', did)
	}
	let collectionCount = 0
	for (const collection of options.wantedCollections ?? []) {
		if (!COLLECTION_RE.test(collection)) continue
		if (++collectionCount > MAX_JETSTREAM_WANTED_COLLECTIONS)
			throw new Error('Jetstream wanted-collection limit exceeded')
		url.searchParams.append('wantedCollections', collection)
	}
	if (cursor !== undefined) url.searchParams.set('cursor', String(cursor))
	const result = url.toString()
	if (Buffer.byteLength(result) > MAX_JETSTREAM_SUBSCRIPTION_URL_BYTES)
		throw new Error('Jetstream subscription URL limit exceeded')
	return result
}

/**
 * A bounded Jetstream consumer. Events are not considered acknowledged until the
 * async handler and optional durable-cursor callback both resolve. Queue overflow,
 * parse errors, and handler errors deliberately reconnect from the last acked cursor.
 */
export class JetstreamClient {
	private ws: WebSocket | null = null
	private destroyed = false
	private accepting = true
	private paused = false
	private connected = false
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private reconnectAttempts = 0
	private lastAckedCursor: number | undefined
	private queue: QueuedEvent[] = []
	private running = 0
	private flushing = false
	private failed = false
	// Queue pressure is recoverable. Keep accepted events and reconnect only
	// after they have drained and advanced the durable cursor.
	private backpressured = false
	private reconnectWhenDrained = false
	private quarantined = false
	private protocolFailures = 0
	private lastProgressAt = 0
	private lastFailureAt = 0
	private lastFailureKind: 'protocol' | 'queue' | 'handler' | 'cursor' | 'connect' | undefined
	private lastReportedErrorAt = 0
	private generation = 0
	private readonly drainWaiters = new Set<() => void>()
	private readonly maxQueue: number
	private readonly concurrency: number
	private readonly maxEventBytes: number
	private readonly reconnectMinMs: number
	private readonly reconnectMaxMs: number
	private readonly reconnectMaxExponent: number
	private readonly progressStaleMs: number

	constructor(private readonly opts: JetstreamOptions) {
		let relay: URL
		try {
			relay = new URL(opts.url)
		} catch {
			throw new Error('Invalid Jetstream relay URL')
		}
		const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(relay.hostname)
		if (
			relay.username ||
			relay.password ||
			relay.search ||
			relay.hash ||
			!relay.hostname ||
			(relay.protocol !== 'wss:' && !(config.allowInsecureDevelopment && loopback && relay.protocol === 'ws:'))
		) {
			throw new Error('Unsafe Jetstream relay URL')
		}
		this.lastAckedCursor = opts.cursor
		this.maxQueue = opts.maxQueue ?? config.intakeQueueMax
		this.concurrency = opts.concurrency ?? config.intakeConcurrency
		this.maxEventBytes = opts.maxEventBytes ?? config.intakeEventMaxBytes
		this.reconnectMinMs = opts.reconnectMinMs ?? config.jetstreamReconnectMinMs
		this.reconnectMaxMs = opts.reconnectMaxMs ?? config.jetstreamReconnectMaxMs
		this.reconnectMaxExponent = opts.reconnectMaxExponent ?? config.jetstreamReconnectMaxExponent
		this.progressStaleMs = opts.progressStaleMs ?? DEFAULT_PROGRESS_STALE_MS
		if (
			!Number.isSafeInteger(this.maxQueue) ||
			this.maxQueue < 1 ||
			!Number.isSafeInteger(this.concurrency) ||
			this.concurrency < 1 ||
			!Number.isSafeInteger(this.maxEventBytes) ||
			this.maxEventBytes < 1
		) {
			throw new Error('Invalid bounded Jetstream queue configuration')
		}
	}

	start(): void {
		if (
			this.destroyed ||
			!this.accepting ||
			this.ws ||
			this.reconnectTimer ||
			this.backpressured ||
			this.reconnectWhenDrained
		)
			return
		this.connect()
	}

	private buildUrl(cursor = this.lastAckedCursor): string {
		return buildJetstreamSubscriptionUrl(this.opts, cursor)
	}

	private connect(): void {
		if (this.destroyed || !this.accepting || this.ws || this.backpressured || this.reconnectWhenDrained) return
		this.failed = false
		const generation = ++this.generation
		let ws: WebSocket
		try {
			ws = new WebSocket(this.buildUrl())
		} catch {
			this.scheduleReconnect(new Error('Jetstream connection setup failed'), 'connect')
			return
		}
		this.ws = ws

		ws.onopen = () => {
			if (this.ws !== ws || generation !== this.generation || this.destroyed || !this.accepting) return
			this.connected = true
			callback(this.opts.onConnect)
		}
		ws.onmessage = (message) => {
			if (
				this.ws !== ws ||
				generation !== this.generation ||
				this.destroyed ||
				!this.accepting ||
				this.failed ||
				this.backpressured
			)
				return
			const text = messageText(message.data, this.maxEventBytes)
			if (!text) {
				this.quarantine(new Error('Jetstream message exceeded the intake limit'))
				return
			}
			let event: JetstreamEvent | null
			try {
				event = parseJetstreamEvent(JSON.parse(text))
			} catch {
				event = null
			}
			if (!event) {
				this.quarantine(new Error('Jetstream protocol event was invalid'))
				return
			}
			if (this.queue.length >= this.maxQueue) {
				// A close cannot put the already received frame back on the wire.
				// This should only be reachable after an event-loop race; retain the
				// bounded queue and let the relay replay this frame from the last ack.
				this.applyBackpressure(new Error('Jetstream intake queue is full'))
				return
			}
			this.queue.push({ event, state: 'queued' })
			this.pump()
			if (this.queue.length >= this.maxQueue) this.applyBackpressure(new Error('Jetstream intake queue is full'))
		}
		ws.onerror = () => {
			if (this.ws !== ws || generation !== this.generation || this.destroyed || !this.accepting) return
			// onclose schedules reconnect. This only records a safe diagnostic state.
			this.report(new Error('Jetstream WebSocket error'))
		}
		ws.onclose = () => {
			if (this.ws !== ws || generation !== this.generation) return
			this.ws = null
			const wasConnected = this.connected
			this.connected = false
			if (wasConnected) callback(this.opts.onDisconnect)
			if (!this.destroyed && this.accepting) {
				// Never replay from a stale cursor while accepted work is still
				// draining, even when the relay (rather than queue pressure) closed
				// the socket.
				if (
					this.backpressured ||
					this.reconnectWhenDrained ||
					this.queue.length !== 0 ||
					this.running !== 0 ||
					this.flushing
				) {
					this.reconnectWhenDrained = true
					this.reconnectAfterDrain()
				} else this.scheduleReconnect()
			}
		}
	}

	private pump(): void {
		if (this.destroyed || this.failed || this.paused) return
		while (this.running < this.concurrency) {
			const item = this.queue.find((candidate) => candidate.state === 'queued')
			if (!item) break
			item.state = 'running'
			this.running++
			void this.run(item)
		}
	}

	private async run(item: QueuedEvent): Promise<void> {
		try {
			await this.opts.onEvent(item.event)
			if (this.destroyed || this.failed || !this.queue.includes(item)) return
			item.state = 'complete'
			void this.flushAcknowledgements()
		} catch {
			this.fail(new Error('Jetstream event handler failed'), 'handler')
		} finally {
			this.running--
			this.pump()
			this.notifyDrained()
		}
	}

	private async flushAcknowledgements(): Promise<void> {
		if (this.flushing || this.destroyed || this.failed) return
		this.flushing = true
		try {
			while (!this.destroyed && !this.failed && this.queue[0]?.state === 'complete') {
				// One durable write per completed prefix, never per event. The cursor
				// is a resume point, so intermediate values only add a round trip
				// each, and a crash mid-prefix replays into deduplicated durable
				// state. Under a backlog this is the difference between the relay
				// round-trip rate and the handler rate.
				let prefix = 0
				while (this.queue[prefix]?.state === 'complete') prefix++
				const item = this.queue[prefix - 1]
				if (!item) break
				try {
					await this.opts.onAcknowledged?.(item.event)
				} catch {
					this.fail(new Error('Jetstream cursor persistence failed'), 'cursor')
					return
				}
				// Failure or teardown during that write owns the queue instead.
				if (this.destroyed || this.failed) return
				this.lastAckedCursor = item.event.time_us
				// A durable acknowledgement proves the connection carried useful work;
				// only then reset exponential reconnect backoff.
				this.reconnectAttempts = 0
				this.protocolFailures = 0
				this.quarantined = false
				this.lastProgressAt = Date.now()
				this.queue.splice(0, prefix)
				this.notifyDrained()
			}
		} finally {
			this.flushing = false
			this.notifyDrained()
		}
	}

	private report(error: Error): void {
		const now = Date.now()
		if (now - this.lastReportedErrorAt < 60_000) return
		this.lastReportedErrorAt = now
		report(this.opts, error)
	}

	private applyBackpressure(error: Error): void {
		if (this.destroyed || this.failed || this.backpressured) return
		this.backpressured = true
		this.lastFailureKind = 'queue'
		this.lastFailureAt = Date.now()
		this.report(error)
		try {
			this.ws?.close()
		} catch {
			// A close race is benign.
		}
		// onclose schedules only after this bounded queue drains. If a custom
		// socket closes synchronously, this remains a no-op until then.
		this.reconnectAfterDrain()
	}

	private reconnectAfterDrain(): void {
		if (
			(!this.backpressured && !this.reconnectWhenDrained) ||
			this.destroyed ||
			!this.accepting ||
			this.ws ||
			this.queue.length !== 0 ||
			this.running !== 0 ||
			this.flushing
		)
			return
		this.backpressured = false
		this.reconnectWhenDrained = false
		this.scheduleReconnect()
	}

	private quarantine(error: Error): void {
		if (this.destroyed || this.failed) return
		this.backpressured = false
		this.reconnectWhenDrained = false
		this.quarantined = true
		this.protocolFailures = Math.min(this.protocolFailures + 1, this.reconnectMaxExponent + 1)
		this.lastFailureKind = 'protocol'
		this.lastFailureAt = Date.now()
		this.failed = true
		this.report(error)
		this.queue = []
		this.notifyDrained()
		try {
			this.ws?.close()
		} catch {
			// A close race is benign.
		}
		// A malformed frame never advances the cursor. onclose probes again from
		// the last durable ack with capped full-jitter backoff. If close races and
		// no socket remains, schedule the half-open probe here.
		if (!this.ws && this.accepting) this.scheduleReconnect()
	}

	private fail(error: Error, kind: 'queue' | 'handler' | 'cursor' = 'handler'): void {
		if (this.destroyed || this.failed) return
		this.backpressured = false
		// A disconnected socket can fail while sibling handlers still own work.
		// Drop their unacknowledged queue entries, but do not replay over those
		// side effects until every in-flight handler and cursor flush has settled.
		this.reconnectWhenDrained = this.running !== 0 || this.flushing
		this.lastFailureKind = kind
		this.lastFailureAt = Date.now()
		this.failed = true
		this.report(error)
		// Do not retain unacknowledged items. Their cursor was never persisted and the
		// relay replay is deduplicated by the durable delivery/event state.
		this.queue = []
		this.notifyDrained()
		try {
			this.ws?.close()
		} catch {
			// A close race is benign.
		}
		if (!this.ws && this.accepting) this.scheduleReconnect()
	}

	private scheduleReconnect(error?: Error, kind?: 'connect'): void {
		if (this.destroyed || !this.accepting || this.reconnectTimer || this.backpressured || this.reconnectWhenDrained)
			return
		if (error) {
			if (kind) {
				this.lastFailureKind = kind
				this.lastFailureAt = Date.now()
			}
			this.report(error)
		}
		this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, this.reconnectMaxExponent + 1)
		const exponent = Math.min(
			Math.max(this.reconnectAttempts - 1, this.protocolFailures - 1),
			this.reconnectMaxExponent,
		)
		const ceiling = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** exponent)
		// Full jitter prevents synchronized reconnect storms. After repeated protocol
		// poison, probe only in the slow half of the capped interval.
		const lower = this.protocolFailures >= this.reconnectMaxExponent + 1 ? Math.ceil(ceiling / 2) : 1
		const delay = lower + Math.floor(Math.random() * Math.max(1, ceiling - lower + 1))
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.connect()
		}, delay)
	}

	get cursor(): number | undefined {
		return this.lastAckedCursor
	}

	get queued(): number {
		return this.queue.length
	}

	get isConnected(): boolean {
		return this.connected && !this.failed && !this.quarantined && !this.backpressured
	}

	/**
	 * Intake health is durable progress, not socket state. A bounded queue that
	 * closes the socket, drains, and replays from its last acknowledgement is
	 * working exactly as designed; only a quarantined stream, or one that has
	 * acknowledged nothing inside the window, has actually stopped serving.
	 */
	get isProgressing(): boolean {
		if (this.destroyed || this.quarantined) return false
		if (this.isConnected) return true
		return this.lastProgressAt !== 0 && Date.now() - this.lastProgressAt < this.progressStaleMs
	}

	get isQuarantined(): boolean {
		return this.quarantined
	}

	get protocolFailureCount(): number {
		return this.protocolFailures
	}

	get lastProgressTime(): number | undefined {
		return this.lastProgressAt || undefined
	}

	get lastFailureTime(): number | undefined {
		return this.lastFailureAt || undefined
	}

	get failureKind(): 'protocol' | 'queue' | 'handler' | 'cursor' | 'connect' | undefined {
		return this.lastFailureKind
	}

	pause(): void {
		this.paused = true
	}

	resume(): void {
		if (this.destroyed) return
		this.paused = false
		this.pump()
	}

	/** Stop reading the socket, retain accepted work, and let drain() finish it. */
	stopAccepting(): void {
		if (!this.accepting) return
		this.accepting = false
		this.paused = false
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		try {
			this.ws?.close()
		} catch {
			// A close race is benign.
		}
		this.pump()
	}

	async drain(): Promise<void> {
		if (this.queue.length === 0 && this.running === 0 && !this.flushing) return
		await new Promise<void>((resolve) => this.drainWaiters.add(resolve))
	}

	private notifyDrained(): void {
		if (this.queue.length !== 0 || this.running !== 0 || this.flushing) return
		this.reconnectAfterDrain()
		for (const resolve of this.drainWaiters) resolve()
		this.drainWaiters.clear()
	}

	/** Permanently close the websocket and discard work that was not accepted durably. */
	destroy(): void {
		if (this.destroyed) return
		this.destroyed = true
		this.accepting = false
		this.paused = false
		this.backpressured = false
		this.reconnectWhenDrained = false
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.reconnectTimer = null
		this.queue = []
		try {
			this.ws?.close()
		} catch {
			// A close race is benign.
		}
		this.ws = null
		this.connected = false
		this.notifyDrained()
	}
}

export function getJetstreamLoggerForTests(): typeof logger {
	return logger
}
