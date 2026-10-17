import { createHash, timingSafeEqual } from 'node:crypto'
import type { Keypair } from '@atproto/crypto'
import { encode } from '@atproto/lex-cbor'
import type { Server, ServerWebSocket } from 'bun'
import { formatLabel, isCid, isLabelSubject, type LabelInput, signLabel } from './labels'
import type { LabelStore, StoredLabel } from './store'

export type LabelerDeps = {
	did: string
	keypair: Keypair
	store: LabelStore
	/** Label values this labeler may emit; anything else is refused. */
	values: readonly string[]
	adminToken: string
	now?: () => Date
}

export type EmitRequest = LabelInput & { note?: string }

export class LabelRequestError extends Error {}

const BACKFILL_PAGE = 500
/** Live labels held for a subscriber while its backfill is still being read. */
const MAX_PENDING = 10_000
const QUERY_LIMIT_MAX = 250

type Subscriber = {
	ws: ServerWebSocket<SocketData>
	/** Highest seq sent on this socket. */
	sent: number
	ready: boolean
	pending: StoredLabel[]
	closed: boolean
}

type SocketData = { cursor: number | undefined; subscriber?: Subscriber }

export function encodeFrame(header: Record<string, unknown>, body: Record<string, unknown>): Uint8Array {
	const head = encode(header as never)
	const payload = encode(body as never)
	const frame = new Uint8Array(head.length + payload.length)
	frame.set(head)
	frame.set(payload, head.length)
	return frame
}

const labelsFrame = (label: StoredLabel) => {
	const { seq, ...wire } = label
	return encodeFrame({ op: 1, t: '#labels' }, { seq, labels: [wire] })
}

const errorFrame = (error: string, message: string) => encodeFrame({ op: -1 }, { error, message })

/** The JSON form of a label: `sig` as `{ $bytes }`, the lexicon's encoding of bytes in JSON. */
export function labelToJson({ seq: _seq, sig, ...label }: StoredLabel) {
	return { ...label, sig: { $bytes: Buffer.from(sig).toString('base64') } }
}

function tokenMatches(header: string | null, token: string): boolean {
	if (!header?.startsWith('Bearer ')) return false
	const digest = (value: string) => createHash('sha256').update(value).digest()
	return timingSafeEqual(digest(header.slice(7)), digest(token))
}

const xrpcError = (status: number, error: string, message: string) => Response.json({ error, message }, { status })

// The read methods are public, and web clients such as pds.ls call them from other origins.
const CORS_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, OPTIONS',
	'access-control-allow-headers': '*',
	'access-control-max-age': '86400',
}

function withCors(res: Response): Response {
	for (const [name, value] of Object.entries(CORS_HEADERS)) res.headers.set(name, value)
	return res
}

function parseCursor(value: string | null): number | undefined | null {
	if (value === null) return undefined
	return /^\d{1,15}$/.test(value) ? Number(value) : null
}

/**
 * An atproto labeler: signs labels into an append-only log, streams them over
 * `com.atproto.label.subscribeLabels` and answers `com.atproto.label.queryLabels`.
 * New labels come only through the bearer-authenticated `POST /admin/labels`.
 */
export function createLabeler(deps: LabelerDeps) {
	const now = deps.now ?? (() => new Date())
	const subscribers = new Set<Subscriber>()
	// One append at a time, so log order, seq order and broadcast order agree.
	let appendChain: Promise<unknown> = Promise.resolve()

	function deliver(sub: Subscriber, label: StoredLabel) {
		if (sub.closed || label.seq <= sub.sent) return
		// 0 means Bun dropped the message: close, and the consumer resumes from its cursor.
		if (sub.ws.send(labelsFrame(label)) === 0) {
			sub.ws.close(1011, 'consumer too slow')
			return
		}
		sub.sent = label.seq
	}

	function broadcast(label: StoredLabel) {
		for (const sub of subscribers) {
			if (sub.ready) deliver(sub, label)
			else if (sub.pending.push(label) > MAX_PENDING) sub.ws.close(1011, 'consumer too slow')
		}
	}

	function validate(request: EmitRequest): LabelInput {
		if (typeof request.uri !== 'string' || !isLabelSubject(request.uri))
			throw new LabelRequestError('uri must be a DID or an at:// record URI')
		if (typeof request.val !== 'string' || !deps.values.includes(request.val))
			throw new LabelRequestError(`val must be one of ${deps.values.join(', ')}`)
		if (request.cid !== undefined && (typeof request.cid !== 'string' || !isCid(request.cid)))
			throw new LabelRequestError('cid must be a CID string')
		if (request.cid !== undefined && !request.uri.startsWith('at://'))
			throw new LabelRequestError('cid only applies to a record URI')
		if (request.exp !== undefined) {
			const exp = new Date(request.exp)
			if (Number.isNaN(exp.getTime()) || exp.toISOString() !== request.exp || exp <= now())
				throw new LabelRequestError('exp must be a future ISO 8601 UTC datetime')
		}
		return {
			uri: request.uri,
			val: request.val,
			...(request.cid ? { cid: request.cid } : {}),
			...(request.neg === true ? { neg: true } : {}),
			...(request.exp ? { exp: request.exp } : {}),
		}
	}

	/** Sign, store and stream one label. */
	async function emit(request: EmitRequest): Promise<StoredLabel> {
		const input = validate(request)
		const note = typeof request.note === 'string' ? request.note.slice(0, 2000) : ''
		const run = appendChain.then(async () => {
			const label = await signLabel(formatLabel(deps.did, input, now().toISOString()), deps.keypair)
			const stored = await deps.store.append(label, note)
			broadcast(stored)
			return stored
		})
		appendChain = run.catch(() => undefined)
		return run
	}

	async function startSubscription(sub: Subscriber, cursor: number | undefined) {
		subscribers.add(sub)
		const head = await deps.store.latestSeq()
		if (cursor === undefined) {
			sub.sent = head
		} else if (cursor > head) {
			sub.ws.send(errorFrame('FutureCursor', 'Cursor is ahead of the latest label'))
			sub.ws.close(1008, 'FutureCursor')
			return
		} else {
			sub.sent = cursor
			while (!sub.closed) {
				const page = await deps.store.after(sub.sent, BACKFILL_PAGE)
				for (const label of page) deliver(sub, label)
				if (page.length < BACKFILL_PAGE) break
			}
		}
		sub.ready = true
		for (const label of sub.pending) deliver(sub, label)
		sub.pending = []
	}

	async function queryLabels(url: URL): Promise<Response> {
		const patterns = url.searchParams.getAll('uriPatterns')
		if (patterns.length === 0) return xrpcError(400, 'InvalidRequest', 'uriPatterns is required')
		const sources = url.searchParams.getAll('sources')
		const limitParam = url.searchParams.get('limit')
		const limit = limitParam === null ? 50 : Number(limitParam)
		if (!Number.isInteger(limit) || limit < 1 || limit > QUERY_LIMIT_MAX)
			return xrpcError(400, 'InvalidRequest', `limit must be 1-${QUERY_LIMIT_MAX}`)
		const cursor = parseCursor(url.searchParams.get('cursor'))
		if (cursor === null) return xrpcError(400, 'InvalidRequest', 'cursor must be a sequence number')
		if (sources.length > 0 && !sources.includes(deps.did)) return Response.json({ labels: [] })
		const labels = await deps.store.current(patterns, cursor ?? 0, limit)
		const last = labels[labels.length - 1]
		return Response.json({
			...(labels.length === limit && last ? { cursor: String(last.seq) } : {}),
			labels: labels.map(labelToJson),
		})
	}

	async function adminEmit(req: Request): Promise<Response> {
		if (!tokenMatches(req.headers.get('authorization'), deps.adminToken))
			return xrpcError(401, 'AuthenticationRequired', 'Bearer token required')
		let body: unknown
		try {
			body = await req.json()
		} catch {
			return xrpcError(400, 'InvalidRequest', 'Body must be JSON')
		}
		try {
			return Response.json(labelToJson(await emit((body ?? {}) as EmitRequest)))
		} catch (error) {
			if (error instanceof LabelRequestError) return xrpcError(400, 'InvalidRequest', error.message)
			throw error
		}
	}

	async function fetch(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
		const url = new URL(req.url)
		if (!url.pathname.startsWith('/xrpc/') || url.pathname === '/xrpc/com.atproto.label.subscribeLabels')
			return route(req, url, server)
		if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }))
		const res = await route(req, url, server)
		return res && withCors(res)
	}

	async function route(req: Request, url: URL, server: Server<SocketData>): Promise<Response | undefined> {
		switch (url.pathname) {
			case '/xrpc/com.atproto.label.subscribeLabels': {
				const cursor = parseCursor(url.searchParams.get('cursor'))
				if (cursor === null) return xrpcError(400, 'InvalidRequest', 'cursor must be a sequence number')
				if (server.upgrade(req, { data: { cursor } })) return undefined
				return xrpcError(426, 'InvalidRequest', 'subscribeLabels is a WebSocket endpoint')
			}
			case '/xrpc/com.atproto.label.queryLabels':
				return req.method === 'GET' ? queryLabels(url) : xrpcError(405, 'InvalidRequest', 'Use GET')
			case '/admin/labels':
				return req.method === 'POST' ? adminEmit(req) : xrpcError(405, 'InvalidRequest', 'Use POST')
			case '/xrpc/_health':
				return Response.json({ version: 'wisp-labeler' })
			case '/':
				return new Response(`This is the wisp.place labeler (${deps.did}).\n`)
			default:
				return url.pathname.startsWith('/xrpc/')
					? xrpcError(501, 'MethodNotImplemented', 'Method not implemented')
					: new Response('Not found', { status: 404 })
		}
	}

	const websocket = {
		open(ws: ServerWebSocket<SocketData>) {
			const sub: Subscriber = { ws, sent: 0, ready: false, pending: [], closed: false }
			ws.data.subscriber = sub
			startSubscription(sub, ws.data.cursor).catch(() => {
				sub.closed = true
				ws.close(1011, 'internal error')
			})
		},
		message() {
			// subscribeLabels is server-to-client only.
		},
		close(ws: ServerWebSocket<SocketData>) {
			const sub = ws.data.subscriber
			if (!sub) return
			sub.closed = true
			subscribers.delete(sub)
		},
	}

	return { fetch, websocket, emit, subscriberCount: () => subscribers.size }
}
