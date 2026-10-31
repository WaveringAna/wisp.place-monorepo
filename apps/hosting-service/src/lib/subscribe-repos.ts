import { MAX_REDIRECT_FILE_BYTES, parseRedirectsFileBytes } from '@wispplace/fs-utils'
import type { Server, ServerWebSocket } from 'bun'
import { requestClient } from './repair-allowance'
import { extractHeaders } from './request-utils'

/**
 * `com.atproto.sync.subscribeRepos` for at-sdp sites: a static site that is its own did:web PDS, and
 * pre-signs its firehose frames into `xrpc/_sdp/events/`. A relay only indexes a repo by dialling the
 * PDS host, so wisp answers the upgrade on the site's own hostname and forwards those frames as they
 * are, by the cursor table of at-sdp's bridge (`pkg/bridge/origin.go`).
 */

export const SUBSCRIBE_REPOS_PATH = '/xrpc/com.atproto.sync.subscribeRepos'
// The `_redirects` target a site opts in with. It names no file, so wherever wisp does not answer the
// upgrade itself the rule is an ordinary 404.
const OPT_IN_TARGET = 'wisp:firehose'
const EVENTS_DIR = 'xrpc/_sdp/events'
const CHECKPOINT_FILE = 'checkpoint.cbor'
const MAX_EVENTS = 1000
const MAX_INDEX_BYTES = 1 << 20
const MAX_FRAME_BYTES = 5_000_000
// Long enough for the read replica and the 10 s site lookup cache to show the update, and for a burst
// of updates to one site to collapse into one reload.
const RELOAD_DELAY_MS = 15_000
const MAX_SOCKETS = 1000
// Per site, so one relay can follow any number of sites; above 1 so a half-open socket cannot block a redial.
const MAX_SOCKETS_PER_CLIENT_PER_SITE = 4

/** A validated `head.json`: every seq is in `(replayableFrom, head]`, ascending, and stored as `<seq>.cbor`. */
export type EventLog = { head: number; replayableFrom: number; seqs: number[] }

export type SocketData = {
	did: string
	rkey: string
	client: string
	/** The log the upgrade was answered from, adopted when the site holds none. */
	log: EventLog
	/** The highest seq sent; the cursor table is re-applied with it on every log change. */
	last: number
	busy: boolean
	again: boolean
	/** Set while the send loop waits for `drain`. */
	resume?: () => void
}

type Socket = ServerWebSocket<SocketData>

type Site = {
	did: string
	rkey: string
	/** The last good log; null once the site drops its opt-in, which stops new frames. */
	log: EventLog | null
	sockets: Set<Socket>
	timer?: ReturnType<typeof setTimeout>
}

export type SubscribeReposDeps = {
	/** A site file as stored, with no `_redirects` applied. */
	serveFile: (did: string, rkey: string, path: string) => Promise<Response>
	isSupporter: (did: string) => Promise<boolean>
	reloadDelayMs?: number
	maxSockets?: number
	maxSocketsPerClientPerSite?: number
}

const isSeq = (value: unknown): value is number => Number.isSafeInteger(value)

/** Validate `head.json` as at-sdp's `Index.Validate` does, with wisp's caps; null when it is unusable. */
export function parseEventLog(text: string): EventLog | null {
	let index: Record<string, unknown>
	try {
		index = Object(JSON.parse(text))
	} catch {
		return null
	}
	const { head, replayable_from: replayableFrom, events } = index
	if (index.version !== 1 || index.checkpoint !== CHECKPOINT_FILE) return null
	if (!isSeq(head) || !isSeq(replayableFrom) || replayableFrom > head) return null
	if (!Array.isArray(events) || events.length > MAX_EVENTS) return null
	const seqs: number[] = []
	let previous = replayableFrom
	for (const event of events) {
		const seq = event?.seq
		if (!isSeq(seq) || seq <= previous || seq > head || event.file !== `${seq}.cbor`) return null
		seqs.push(seq)
		previous = seq
	}
	return { head, replayableFrom, seqs }
}

/** A relay's cursor: absent counts as 0, null when malformed. at-sdp seqs are 16-digit microsecond values. */
function parseCursor(value: string | null): number | null {
	if (value === null) return 0
	const cursor = Number(value)
	return /^\d+$/.test(value) && Number.isSafeInteger(cursor) ? cursor : null
}

/** The frames to send after `last`, by at-sdp's cursor table. A cursor past head tails: never FutureCursor. */
function framesAfter(log: EventLog, last: number): Array<[seq: number, file: string]> {
	if (last >= log.head) return []
	if (last >= log.replayableFrom) return log.seqs.filter((seq) => seq > last).map((seq) => [seq, `${seq}.cbor`])
	return [[log.head, CHECKPOINT_FILE]]
}

// Nothing at this URL may be cached: an edge cache replaying a 404 or 302 would answer a relay's next upgrade.
function refuse(status: number, error: string, message: string): Response {
	return Response.json({ error, message }, { status, headers: { 'Cache-Control': 'no-store' } })
}

const siteKey = (did: string, rkey: string) => `${did}/${rkey}`

/**
 * Answer subscribeRepos for opted-in sites. `handle` answers a request or returns null to serve the
 * path as today; `websocket` goes on `Bun.serve`; `siteUpdated` follows deploys; `closeAll` is for shutdown.
 */
export function createSubscribeRepos({
	serveFile,
	isSupporter,
	reloadDelayMs = RELOAD_DELAY_MS,
	maxSockets = MAX_SOCKETS,
	maxSocketsPerClientPerSite = MAX_SOCKETS_PER_CLIENT_PER_SITE,
}: SubscribeReposDeps) {
	const sites = new Map<string, Site>()
	let socketCount = 0
	let closing = false

	/** A site file's bytes, or null when the site has none within `limit`. Throws when storage cannot say. */
	async function readFile(did: string, rkey: string, path: string, limit: number): Promise<Uint8Array | null> {
		const response = await serveFile(did, rkey, path)
		// File serving always sets Content-Length, so an oversized file is refused before its body is read.
		if (response.status !== 200 || Number(response.headers.get('content-length')) > limit) {
			await response.body?.cancel()
			if (response.status === 200 || response.status === 404) return null
			throw new Error(`${path}: HTTP ${response.status}`)
		}
		const bytes = new Uint8Array(await response.arrayBuffer())
		return bytes.byteLength > limit ? null : bytes
	}

	/**
	 * The site's event log: null when the site has not opted in, undefined when its log is unusable.
	 * Throws when storage cannot say, so a reload retries a blip rather than reading it as an opt-out.
	 */
	async function readOptedInLog(did: string, rkey: string): Promise<EventLog | null | undefined> {
		const redirects = await readFile(did, rkey, '_redirects', MAX_REDIRECT_FILE_BYTES)
		const rules = redirects && parseRedirectsFileBytes(redirects)
		if (!rules?.some((rule) => rule.from === SUBSCRIBE_REPOS_PATH && rule.to === OPT_IN_TARGET)) return null
		const index = await readFile(did, rkey, `${EVENTS_DIR}/head.json`, MAX_INDEX_BYTES)
		return (index && parseEventLog(new TextDecoder().decode(index))) ?? undefined
	}

	function schedule(site: Site): void {
		clearTimeout(site.timer)
		site.timer = setTimeout(() => void reload(site), reloadDelayMs)
	}

	async function reload(site: Site): Promise<void> {
		site.timer = undefined
		const log = await readOptedInLog(site.did, site.rkey).catch(() => undefined)
		if (sites.get(siteKey(site.did, site.rkey)) !== site) return
		if (log === null) {
			site.log = null
			return
		}
		// at-sdp seqs only grow, so a log behind the held one is a slow read that lost a race or a lagging
		// replica. Like an unusable log, keep forwarding the last good one and look again.
		if (!log || (site.log && log.head < site.log.head)) {
			schedule(site)
			return
		}
		site.log = log
		for (const ws of site.sockets) pump(ws)
	}

	function pump(ws: Socket): void {
		if (ws.data.busy) {
			ws.data.again = true
			return
		}
		ws.data.busy = true
		void send(ws)
	}

	async function send(ws: Socket): Promise<void> {
		const { data } = ws
		try {
			do {
				data.again = false
				const site = sites.get(siteKey(data.did, data.rkey))
				if (!site?.log) return
				for (const [seq, file] of framesAfter(site.log, data.last)) {
					const path = `${EVENTS_DIR}/${file}`
					const frame = await readFile(data.did, data.rkey, path, MAX_FRAME_BYTES).catch(() => null)
					if (!site.sockets.has(ws)) return
					if (!frame) {
						// Skipping it would leave a gap in the relay's copy of the repo, so wait for it instead.
						if (!data.again) schedule(site)
						break
					}
					const status = ws.sendBinary(frame)
					// Dropped: the same frame goes again on the next drain or update.
					if (status === 0) return
					data.last = seq
					if (status === -1) {
						await new Promise<void>((resolve) => {
							data.resume = resolve
						})
						if (!site.sockets.has(ws)) return
					}
				}
			} while (data.again)
		} finally {
			// Cleared before the promise settles, so a pump arriving after the last check starts a new loop.
			data.busy = false
		}
	}

	function socketsFrom(site: Site | undefined, client: string): number {
		let count = 0
		for (const ws of site?.sockets ?? []) if (ws.data.client === client) count++
		return count
	}

	/**
	 * Answer subscribeRepos for a site reached through its custom domain, or null to serve the path as
	 * today: only a supporter's site whose `_redirects` opts in and whose event log parses is answered.
	 */
	async function handle(
		request: Request,
		server: Server<SocketData>,
		did: string,
		rkey: string,
	): Promise<Response | null> {
		if (!(await isSupporter(did).catch(() => false))) return null
		const key = siteKey(did, rkey)
		const log = sites.get(key)?.log ?? (await readOptedInLog(did, rkey).catch(() => null))
		if (!log) return null

		if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
			return refuse(426, 'InvalidRequest', 'subscribeRepos is a WebSocket endpoint')
		const last = parseCursor(new URL(request.url).searchParams.get('cursor'))
		if (last === null) return refuse(400, 'InvalidRequest', 'cursor must be a non-negative integer')
		const client = requestClient(extractHeaders(request.headers))
		if (closing || socketCount >= maxSockets || socketsFrom(sites.get(key), client) >= maxSocketsPerClientPerSite)
			return refuse(503, 'NotEnoughResources', 'Too many subscribers; try again later')

		const data: SocketData = { did, rkey, client, log, last, busy: false, again: false }
		if (!server.upgrade(request, { data }))
			return refuse(426, 'InvalidRequest', 'subscribeRepos is a WebSocket endpoint')
		// Bun ignores the response to an upgraded request; Hono's middleware needs one to finish.
		return new Response(null)
	}

	const websocket = {
		// Relays send nothing but control frames.
		maxPayloadLength: 4096,
		open(ws: Socket) {
			const { did, rkey, log } = ws.data
			const key = siteKey(did, rkey)
			let site = sites.get(key)
			if (!site) {
				site = { did, rkey, log, sockets: new Set() }
				sites.set(key, site)
				// An update that settled while nobody followed the site was not heard, and this log may
				// predate it: a relay dials as soon as at-sdp's notify asks, right after the deploy.
				schedule(site)
			}
			site.log ??= log
			site.sockets.add(ws)
			socketCount++
			pump(ws)
		},
		message() {},
		drain(ws: Socket) {
			const { resume } = ws.data
			ws.data.resume = undefined
			if (resume) resume()
			else pump(ws)
		},
		close(ws: Socket) {
			const key = siteKey(ws.data.did, ws.data.rkey)
			const site = sites.get(key)
			if (site?.sockets.delete(ws)) {
				socketCount--
				if (site.sockets.size === 0) {
					clearTimeout(site.timer)
					sites.delete(key)
				}
			}
			ws.data.resume?.()
		},
	}

	return {
		handle,
		websocket,
		/** Reload a followed site's log once its update has settled. Sites nobody follows cost nothing. */
		siteUpdated(did: string, rkey: string): void {
			const site = sites.get(siteKey(did, rkey))
			if (site) schedule(site)
		},
		/** Refuse new subscribers and close every socket as going away (1001), so relays redial another instance. */
		closeAll(): void {
			closing = true
			for (const site of sites.values()) {
				clearTimeout(site.timer)
				for (const ws of site.sockets) ws.close(1001, 'server shutting down')
			}
		},
	}
}

export type SubscribeRepos = ReturnType<typeof createSubscribeRepos>
