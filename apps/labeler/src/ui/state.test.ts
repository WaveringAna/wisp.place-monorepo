import { describe, expect, test } from 'bun:test'
import type { SiteSummary, VerdictRecord } from '../moderation/types'
import { type Base, initialState, inView, nextFocus, ownVerdict, project, reducer, type State } from './state'

const DID = 'did:plc:alice'

function site(rkey: string, patch: Partial<SiteSummary> = {}): SiteSummary {
	return {
		uri: `at://${DID}/place.wisp.fs/${rkey}`,
		did: DID,
		rkey,
		handle: 'alice.test',
		url: `https://${rkey}.wisp.place/`,
		domains: [`${rkey}.wisp.place`],
		title: rkey,
		excerpt: '',
		outbound: [],
		files: 1,
		firstSeen: '2026-01-01T00:00:00Z',
		updated: '2026-01-01T00:00:00Z',
		deleted: false,
		state: 'flagged',
		verdict: null,
		triage: { flag: true, category: 'spam', reason: 'r', confidence: 0.9, model: 'm', at: '2026-01-01T00:00:00Z' },
		labels: [],
		...patch,
	}
}

const record = (value: VerdictRecord['value'], scope: VerdictRecord['scope'] = 'site'): VerdictRecord => ({
	value,
	note: '',
	by: 'did:plc:mod',
	at: '2026-01-02T00:00:00Z',
	scope,
})

function loaded(...sites: SiteSummary[]): State {
	return reducer(initialState(), {
		type: 'list/loaded',
		key: 'flagged',
		items: sites,
		cursor: 'next',
		counts: { flagged: sites.length, pending: 0, recent: sites.length, reviewed: 0 },
		append: false,
	})
}

const visible = (base: Base) => Object.values(base.sites).filter((s) => inView('flagged', s))

describe('optimistic verdicts', () => {
	test('a pending verdict shows at once and moves the counts, without touching the server state', () => {
		const a = site('a')
		let state = loaded(a, site('b'))
		state = reducer(state, { type: 'op/start', op: { id: 1, kind: 'verdict', subject: a.uri, record: record('spam') } })
		const shown = project(state.base, state.ops)
		expect(shown.sites[a.uri]!.verdict?.value).toBe('spam')
		expect(shown.sites[a.uri]!.state).toBe('reviewed')
		expect(shown.counts).toEqual({ flagged: 1, pending: 0, recent: 2, reviewed: 1 })
		expect(state.base.sites[a.uri]!.verdict).toBeNull()
		expect(visible(shown).map((s) => s.rkey)).toEqual(['b'])
	})

	test('a failed op disappears and leaves an error on its subject', () => {
		const a = site('a')
		let state = loaded(a)
		state = reducer(state, { type: 'op/start', op: { id: 1, kind: 'verdict', subject: a.uri, record: record('fine') } })
		state = reducer(state, { type: 'op/fail', id: 1, error: 'boom' })
		expect(project(state.base, state.ops).sites[a.uri]!.verdict).toBeNull()
		expect(state.errors[a.uri]).toBe('boom')
		expect(state.base.counts?.flagged).toBe(1)
		// The next action on it clears the error.
		state = reducer(state, { type: 'op/start', op: { id: 2, kind: 'verdict', subject: a.uri, record: record('fine') } })
		expect(state.errors[a.uri]).toBeUndefined()
	})

	test('a confirmed op folds into the base with the site the server returned', () => {
		const a = site('a')
		let state = loaded(a)
		state = reducer(state, {
			type: 'op/start',
			op: { id: 1, kind: 'verdict', subject: a.uri, record: record('empty') },
		})
		const fromServer = site('a', { state: 'reviewed', verdict: { ...record('empty'), at: '2026-01-03T00:00:00Z' } })
		state = reducer(state, { type: 'op/done', id: 1, site: fromServer })
		expect(state.ops).toEqual([])
		expect(state.base.sites[a.uri]).toEqual(fromServer)
		expect(state.base.counts).toEqual({ flagged: 0, pending: 0, recent: 1, reviewed: 1 })
	})

	test('an account verdict covers its sites but not a site with its own verdict', () => {
		const own = site('own', { verdict: record('fine'), state: 'reviewed' })
		const other = site('other')
		let state = loaded(own, other)
		state = reducer(state, {
			type: 'op/start',
			op: { id: 1, kind: 'verdict', subject: DID, record: record('spam', 'account') },
		})
		const shown = project(state.base, state.ops)
		expect(shown.sites[own.uri]!.verdict?.value).toBe('fine')
		expect(shown.sites[other.uri]!.verdict).toEqual(record('spam', 'account'))
		expect(ownVerdict(shown, DID)?.value).toBe('spam')
		expect(ownVerdict(shown, other.uri)).toBeNull()
	})

	test('clearing a site verdict falls back to the account verdict, and to its triage state', () => {
		const a = site('a', { verdict: record('fine'), state: 'reviewed' })
		const state = loaded(a)
		const cleared = project(state.base, [{ id: 1, kind: 'verdict', subject: a.uri, record: null }])
		expect(cleared.sites[a.uri]!.verdict).toBeNull()
		expect(cleared.sites[a.uri]!.state).toBe('flagged')

		const withAccount = loaded(a, site('b', { verdict: record('spam', 'account'), state: 'reviewed' }))
		const fallback = project(withAccount.base, [{ id: 1, kind: 'verdict', subject: a.uri, record: null }])
		expect(fallback.sites[a.uri]!.verdict?.value).toBe('spam')
	})

	test('ops replay in order, so an undo after an action restores the previous value', () => {
		const a = site('a')
		const state = loaded(a)
		const shown = project(state.base, [
			{ id: 1, kind: 'verdict', subject: a.uri, record: record('spam') },
			{ id: 2, kind: 'verdict', subject: a.uri, record: null },
		])
		expect(shown.sites[a.uri]).toEqual(a)
	})
})

describe('labels', () => {
	test('an account takedown shows on every site of the account and takes them out of flagged', () => {
		const state = loaded(site('a'), site('b'))
		const shown = project(state.base, [
			{ id: 1, kind: 'label', subject: DID, val: '!takedown', neg: false, cts: '2026-01-02T00:00:00Z' },
		])
		for (const s of Object.values(shown.sites))
			expect(s.labels).toEqual([{ uri: DID, val: '!takedown', cts: '2026-01-02T00:00:00Z' }])
		expect(shown.counts?.flagged).toBe(0)
	})

	test('a restore removes only that label, and the server answer replaces the subject labels', () => {
		const a = site('a', {
			labels: [
				{ uri: DID, val: '!hide', cts: 'x' },
				{ uri: `at://${DID}/place.wisp.fs/a`, val: '!takedown', cts: 'y' },
			],
		})
		let state = loaded(a)
		state = reducer(state, {
			type: 'op/start',
			op: { id: 1, kind: 'label', subject: a.uri, val: '!takedown', neg: true, cts: 'z' },
		})
		expect(project(state.base, state.ops).sites[a.uri]!.labels).toEqual([{ uri: DID, val: '!hide', cts: 'x' }])
		state = reducer(state, { type: 'op/done', id: 1, labels: [] })
		expect(state.base.sites[a.uri]!.labels).toEqual([{ uri: DID, val: '!hide', cts: 'x' }])
	})
})

describe('lists', () => {
	test('load more appends without duplicates and a refresh replaces', () => {
		let state = loaded(site('a'), site('b'))
		state = reducer(state, {
			type: 'list/loaded',
			key: 'flagged',
			items: [site('b'), site('c')],
			cursor: null,
			append: true,
		})
		expect(state.lists.flagged!.uris.map((u) => u.split('/').pop())).toEqual(['a', 'b', 'c'])
		expect(state.lists.flagged!.cursor).toBeNull()
		state = reducer(state, { type: 'list/loaded', key: 'flagged', items: [site('c')], cursor: null, append: false })
		expect(state.lists.flagged!.uris).toHaveLength(1)
	})
})

describe('nextFocus', () => {
	test('moves to the next visible item, else the previous, else nothing', () => {
		expect(nextFocus(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
		expect(nextFocus(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b')
		expect(nextFocus(['a', 'b', 'c'], ['a', 'c'], 'c')).toBe('c')
		expect(nextFocus(['a'], [], 'a')).toBeNull()
		expect(nextFocus([], ['x'], null)).toBe('x')
	})
})
