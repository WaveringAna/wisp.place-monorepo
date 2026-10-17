/**
 * The interface's state. Server data lives in `base`; actions the moderator took
 * whose POST has not answered yet are `ops`, replayed over `base` by `project` on
 * every render. A failed op is dropped (its effect disappears with it), a confirmed
 * one is folded into `base` together with what the server returned. Nothing here
 * refetches a list after an action.
 */
import type {
	AccountView,
	ActiveLabel,
	ModerationAction,
	ModerationEvent,
	QueueView,
	SiteSummary,
	SubjectState,
	VerdictRecord,
} from '../moderation/types'
import { isDid } from './format'

export type Counts = Record<QueueView, number>
export type AccountEntry = Omit<AccountView, 'sites'> & { sites: string[] }

export type Base = {
	sites: Record<string, SiteSummary>
	accounts: Record<string, AccountEntry>
	counts: Counts | null
}

export type PendingOp =
	| { id: number; kind: 'verdict'; subject: string; record: VerdictRecord | null }
	| { id: number; kind: 'label'; subject: string; val: ModerationAction; neg: boolean; cts: string }

export type ListState = {
	uris: string[]
	cursor: string | null
	loading: boolean
	loaded: boolean
	error: string | null
}

export type EventsState = {
	items: ModerationEvent[]
	cursor: string | null
	loading: boolean
	loaded: boolean
	error: string | null
}

export type State = {
	base: Base
	ops: PendingOp[]
	/** Keyed by queue view, `search:<q>`. */
	lists: Record<string, ListState>
	events: EventsState
	/** The last failure per subject (site URI or DID), shown on its card. */
	errors: Record<string, string>
}

export const EMPTY_LIST: ListState = { uris: [], cursor: null, loading: false, loaded: false, error: null }

export function initialState(): State {
	return {
		base: { sites: {}, accounts: {}, counts: null },
		ops: [],
		lists: {},
		events: { items: [], cursor: null, loading: false, loaded: false, error: null },
		errors: {},
	}
}

export function takenDown(site: SiteSummary): boolean {
	return site.labels.some((label) => label.val === '!takedown')
}

/** Whether a site belongs in a queue view, by the rules in DESIGN.md. */
export function inView(view: QueueView, site: SiteSummary): boolean {
	switch (view) {
		case 'flagged':
			return site.state === 'flagged' && site.verdict === null && !takenDown(site)
		case 'pending':
			return site.state === 'pending'
		case 'recent':
			return true
		case 'reviewed':
			return site.verdict !== null
	}
}

const COUNTED: QueueView[] = ['flagged', 'pending', 'reviewed']

/** Store sites, moving the view counts by every site that entered or left a view. */
export function putSites(base: Base, sites: SiteSummary[]): Base {
	if (sites.length === 0) return base
	const next = { ...base.sites }
	let counts = base.counts
	for (const site of sites) {
		const prev = next[site.uri]
		if (prev && counts) {
			for (const view of COUNTED) {
				const delta = Number(inView(view, site)) - Number(inView(view, prev))
				if (delta !== 0) counts = { ...counts, [view]: Math.max(0, counts[view] + delta) }
			}
		}
		next[site.uri] = site
	}
	return { ...base, sites: next, counts }
}

function stateFor(site: SiteSummary, verdict: VerdictRecord | null): SubjectState {
	if (verdict) return 'reviewed'
	if (site.state !== 'reviewed') return site.state
	if (!site.triage) return 'pending'
	return site.triage.flag ? 'flagged' : 'clear'
}

/** The account's own verdict as far as this client knows it. */
export function accountVerdict(base: Base, did: string): VerdictRecord | null {
	const account = base.accounts[did]
	if (account) return account.verdict
	for (const site of Object.values(base.sites)) {
		if (site.did === did && site.verdict?.scope === 'account') return site.verdict
	}
	return null
}

/** The verdict recorded on exactly this subject (not inherited), to restore on undo. */
export function ownVerdict(base: Base, subject: string): VerdictRecord | null {
	if (isDid(subject)) return accountVerdict(base, subject)
	const verdict = base.sites[subject]?.verdict ?? null
	return verdict?.scope === 'site' ? verdict : null
}

/** Record (or clear, with null) the verdict on a site URI or an account DID. */
export function applyVerdict(base: Base, subject: string, record: VerdictRecord | null): Base {
	if (isDid(subject)) {
		const touched: SiteSummary[] = []
		for (const site of Object.values(base.sites)) {
			if (site.did !== subject || site.verdict?.scope === 'site') continue
			touched.push({ ...site, verdict: record, state: stateFor(site, record) })
		}
		const next = putSites(base, touched)
		const account = next.accounts[subject]
		if (!account) return next
		return { ...next, accounts: { ...next.accounts, [subject]: { ...account, verdict: record } } }
	}
	const site = base.sites[subject]
	if (!site) return base
	const verdict = record ?? accountVerdict(base, site.did)
	return putSites(base, [{ ...site, verdict, state: stateFor(site, verdict) }])
}

/** The active labels on exactly this subject. */
export function labelsOn(base: Base, subject: string): ActiveLabel[] {
	const account = isDid(subject) ? base.accounts[subject] : undefined
	if (account) return account.labels.filter((label) => label.uri === subject)
	for (const site of Object.values(base.sites)) {
		if (site.uri === subject || site.did === subject) return site.labels.filter((label) => label.uri === subject)
	}
	return []
}

/** Replace the labels on `subject` everywhere they show: its sites (or its account's) and the account. */
export function replaceLabels(base: Base, subject: string, labels: ActiveLabel[]): Base {
	const own = labels.filter((label) => label.uri === subject)
	const touched: SiteSummary[] = []
	for (const site of Object.values(base.sites)) {
		if (site.uri !== subject && site.did !== subject) continue
		touched.push({ ...site, labels: [...site.labels.filter((label) => label.uri !== subject), ...own] })
	}
	const next = putSites(base, touched)
	const account = isDid(subject) ? next.accounts[subject] : undefined
	if (!account) return next
	return { ...next, accounts: { ...next.accounts, [subject]: { ...account, labels: own } } }
}

export function applyLabel(base: Base, subject: string, val: string, neg: boolean, cts: string): Base {
	const current = labelsOn(base, subject)
	const has = current.some((label) => label.val === val)
	if (neg ? !has : has) return base
	const next = neg ? current.filter((label) => label.val !== val) : [...current, { uri: subject, val, cts }]
	return replaceLabels(base, subject, next)
}

export function applyOp(base: Base, op: PendingOp): Base {
	return op.kind === 'verdict'
		? applyVerdict(base, op.subject, op.record)
		: applyLabel(base, op.subject, op.val, op.neg, op.cts)
}

/** What the moderator sees: the server's state with every unanswered action applied. */
export function project(base: Base, ops: PendingOp[]): Base {
	return ops.reduce(applyOp, base)
}

/** Whether an unanswered action touches this site (directly or through its account). */
export function isPending(ops: PendingOp[], site: SiteSummary): boolean {
	return ops.some((op) => op.subject === site.uri || op.subject === site.did)
}

export type Action =
	| { type: 'list/loading'; key: string }
	| { type: 'list/loaded'; key: string; items: SiteSummary[]; cursor: string | null; counts?: Counts; append: boolean }
	| { type: 'list/error'; key: string; error: string }
	| { type: 'account/loaded'; account: AccountView }
	| { type: 'events/loading' }
	| { type: 'events/loaded'; items: ModerationEvent[]; cursor: string | null; append: boolean }
	| { type: 'events/error'; error: string }
	| { type: 'op/start'; op: PendingOp }
	| { type: 'op/done'; id: number; site?: SiteSummary | null; labels?: ActiveLabel[] }
	| { type: 'op/fail'; id: number; error: string }

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
	if (!(key in record)) return record
	const { [key]: _, ...rest } = record
	return rest
}

export function reducer(state: State, action: Action): State {
	switch (action.type) {
		case 'list/loading': {
			const list = state.lists[action.key] ?? EMPTY_LIST
			return { ...state, lists: { ...state.lists, [action.key]: { ...list, loading: true, error: null } } }
		}
		case 'list/loaded': {
			const list = state.lists[action.key] ?? EMPTY_LIST
			const seen = new Set(action.append ? list.uris : [])
			const uris = action.append ? [...list.uris] : []
			for (const item of action.items) {
				if (!seen.has(item.uri)) uris.push(item.uri)
				seen.add(item.uri)
			}
			let base = putSites(state.base, action.items)
			if (action.counts) base = { ...base, counts: action.counts }
			const loaded: ListState = { uris, cursor: action.cursor, loading: false, loaded: true, error: null }
			return { ...state, base, lists: { ...state.lists, [action.key]: loaded } }
		}
		case 'list/error': {
			const list = state.lists[action.key] ?? EMPTY_LIST
			const failed = { ...list, loading: false, error: action.error }
			return { ...state, lists: { ...state.lists, [action.key]: failed } }
		}
		case 'account/loaded': {
			const { sites, ...rest } = action.account
			const base = putSites(state.base, sites)
			const entry: AccountEntry = { ...rest, sites: sites.map((site) => site.uri) }
			return { ...state, base: { ...base, accounts: { ...base.accounts, [entry.did]: entry } } }
		}
		case 'events/loading':
			return { ...state, events: { ...state.events, loading: true, error: null } }
		case 'events/loaded': {
			const items = action.append ? [...state.events.items, ...action.items] : action.items
			return { ...state, events: { items, cursor: action.cursor, loading: false, loaded: true, error: null } }
		}
		case 'events/error':
			return { ...state, events: { ...state.events, loading: false, error: action.error } }
		case 'op/start':
			return {
				...state,
				ops: [...state.ops, action.op],
				errors: withoutKey(state.errors, action.op.subject),
			}
		case 'op/done': {
			const op = state.ops.find((candidate) => candidate.id === action.id)
			if (!op) return state
			let base = applyOp(state.base, op)
			if (action.site) base = putSites(base, [action.site])
			if (action.labels) base = replaceLabels(base, op.subject, action.labels)
			return { ...state, base, ops: state.ops.filter((candidate) => candidate !== op) }
		}
		case 'op/fail': {
			const op = state.ops.find((candidate) => candidate.id === action.id)
			if (!op) return state
			return {
				...state,
				ops: state.ops.filter((candidate) => candidate !== op),
				errors: { ...state.errors, [op.subject]: action.error },
			}
		}
	}
}

/**
 * Where focus goes when the focused item leaves the visible list: the next item
 * after it that is still visible, else the nearest one before it.
 */
export function nextFocus(before: string[], after: string[], focused: string | null): string | null {
	if (focused === null) return after[0] ?? null
	const visible = new Set(after)
	if (visible.has(focused)) return focused
	const index = before.indexOf(focused)
	if (index === -1) return after[0] ?? null
	for (let i = index + 1; i < before.length; i++) {
		if (visible.has(before[i]!)) return before[i]!
	}
	for (let i = index - 1; i >= 0; i--) {
		if (visible.has(before[i]!)) return before[i]!
	}
	return null
}
