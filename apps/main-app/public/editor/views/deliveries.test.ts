import { describe, expect, test } from 'bun:test'
import type { WebhookDelivery } from '../api'
import { visibleDeliveries } from './deliveries'

const delivery = (overrides: Partial<WebhookDelivery>): WebhookDelivery => ({
	rkey: 'w',
	url: 'https://hooks.example/a',
	eventKind: 'create',
	eventDid: 'did:x',
	eventCollection: 'app.bsky.feed.post',
	eventRkey: 'r',
	deliveredAt: '2026-10-03T12:00:00.000Z',
	status: 'ok',
	...overrides,
})

const list = [
	delivery({ eventRkey: '1', deliveredAt: '2026-10-03T10:00:00.000Z', status: 'failed' }),
	delivery({ eventRkey: '2', deliveredAt: '2026-10-03T12:00:00.000Z', eventCollection: 'place.wisp.fs' }),
	delivery({ eventRkey: '3', deliveredAt: '2026-10-03T11:00:00.000Z', url: 'https://other.example/b' }),
]

describe('visibleDeliveries', () => {
	test('filters by status and by collection or endpoint text', () => {
		const base = { query: '', status: 'all', column: 'deliveredAt', direction: 'descending' } as const
		expect(visibleDeliveries(list, { ...base, status: 'failed' }).map((d) => d.eventRkey)).toEqual(['1'])
		expect(visibleDeliveries(list, { ...base, query: 'WISP' }).map((d) => d.eventRkey)).toEqual(['2'])
		expect(visibleDeliveries(list, { ...base, query: 'other.example' }).map((d) => d.eventRkey)).toEqual(['3'])
	})

	test('sorts by the chosen column without touching the input', () => {
		const view = { query: '', status: 'all', column: 'deliveredAt', direction: 'descending' } as const
		expect(visibleDeliveries(list, view).map((d) => d.eventRkey)).toEqual(['2', '3', '1'])
		expect(visibleDeliveries(list, { ...view, direction: 'ascending' }).map((d) => d.eventRkey)).toEqual([
			'1',
			'3',
			'2',
		])
		expect(list.map((d) => d.eventRkey)).toEqual(['1', '2', '3'])
	})
})
