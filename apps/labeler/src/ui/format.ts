import type { ModerationEvent } from '../moderation/types'

const UNITS: [number, string][] = [
	[365 * 24 * 3600, 'y'],
	[30 * 24 * 3600, 'mo'],
	[7 * 24 * 3600, 'w'],
	[24 * 3600, 'd'],
	[3600, 'h'],
	[60, 'm'],
]

/** "3h", "2d", "just now": how long ago `iso` was, relative to `now` (ms). */
export function ago(iso: string, now: number): string {
	const seconds = Math.floor((now - Date.parse(iso)) / 1000)
	if (!Number.isFinite(seconds)) return ''
	if (seconds < 60) return 'just now'
	for (const [size, unit] of UNITS) {
		if (seconds >= size) return `${Math.floor(seconds / size)}${unit}`
	}
	return 'just now'
}

/** did:plc:abcdefghijklmnop -> did:plc:abcd…mnop */
export function shortDid(did: string): string {
	const prefix = did.startsWith('did:plc:') ? 'did:plc:' : did.startsWith('did:web:') ? 'did:web:' : ''
	const rest = did.slice(prefix.length)
	if (prefix === 'did:web:' || rest.length <= 12) return did
	return `${prefix}${rest.slice(0, 4)}…${rest.slice(-4)}`
}

export function isDid(subject: string): boolean {
	return subject.startsWith('did:')
}

/** at://did/collection/rkey -> { did, rkey }, or null for a DID or anything else. */
export function parseSiteUri(uri: string): { did: string; rkey: string } | null {
	const match = /^at:\/\/([^/]+)\/[^/]+\/([^/]+)$/.exec(uri)
	return match ? { did: match[1]!, rkey: match[2]! } : null
}

/** How an event names its subject: "@handle · title", "@handle", else the rkey or a short DID. */
export function eventSubject(event: ModerationEvent): string {
	const site = parseSiteUri(event.subject)
	const who = event.handle ? `@${event.handle}` : null
	if (!site) return who ?? shortDid(event.subject)
	const what = event.title || site.rkey
	return who ? `${who} · ${what}` : what
}

const LABEL_NAMES: Record<string, string> = { '!takedown': 'taken down', '!hide': 'hidden' }

export function labelName(val: string): string {
	return LABEL_NAMES[val] ?? val
}

export function actorName(actor: string, me?: { did: string; handle: string } | null): string {
	if (me && actor === me.did) return `@${me.handle}`
	if (actor.startsWith('model:')) return actor.slice('model:'.length)
	if (isDid(actor)) return shortDid(actor)
	return actor
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null
}

/**
 * One line for an audit event. `data` is free-form on the wire, so this reads the
 * keys it knows and ignores the rest.
 */
export function describeEvent(event: ModerationEvent): string {
	const data = event.data
	switch (event.kind) {
		case 'seen':
			return 'seen'
		case 'triaged': {
			const category = text(data.category)
			const reason = text(data.reason)
			const head = data.flag === true ? `flagged${category ? ` as ${category}` : ''}` : 'cleared by triage'
			return reason ? `${head}: ${reason}` : head
		}
		case 'verdict': {
			const verdict = text(data.verdict) ?? text(data.value)
			const note = text(data.note)
			const head = verdict ? `verdict ${verdict}` : 'verdict cleared'
			return note ? `${head} (${note})` : head
		}
		case 'label': {
			const val = text(data.val) ?? 'label'
			const note = text(data.note)
			const head = data.neg === true ? `restored ${val}` : `applied ${val}`
			return note ? `${head} (${note})` : head
		}
		default:
			return event.kind
	}
}
