import { expect, test } from 'bun:test'
import { createFixtureStore, FAILING_HANDLE } from './fixtures'

test('fixtures page the queue and apply verdicts and labels', () => {
	const store = createFixtureStore(Date.parse('2026-10-15T12:00:00Z'))
	const first = store.queue('recent', null, 20)
	expect(first.items).toHaveLength(20)
	expect(first.cursor).toBe('20')
	expect(store.queue('recent', first.cursor, 20).items.length).toBeGreaterThan(0)

	const flagged = store.queue('flagged', null, 50)
	const target = flagged.items[0]!
	store.verdict({ uri: target.uri, verdict: 'spam' }, 'did:plc:mod')
	const after = store.queue('flagged', null, 50)
	expect(after.items.some((site) => site.uri === target.uri)).toBe(false)
	expect(after.counts.flagged).toBe(flagged.counts.flagged - 1)

	const labels = store.label({ uri: target.did, val: '!takedown', neg: false }, 'did:plc:mod')
	expect(labels?.labels.map((label) => label.val)).toEqual(['!takedown'])
	expect(store.account(target.did)?.labels).toHaveLength(1)
	expect(store.search(FAILING_HANDLE).items.every((site) => store.failing(site.uri))).toBe(true)
})
