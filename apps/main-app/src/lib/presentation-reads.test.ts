import { describe, expect, test } from 'bun:test'
import { DELETED_SITE_RECORD_CID } from '@wispplace/constants'
import type { SQL } from 'bun'
import { createPresentationReadQueries } from './presentation-reads'

describe('presentation read queries', () => {
	test('gets sites and all domain badges in one bulk query', async () => {
		const calls: Array<{ text: string; values: unknown[] }> = []
		const rows = [
			{
				did: 'did:example:alice',
				rkey: 'first',
				display_name: 'first',
				created_at: 100,
				updated_at: 200,
				domain_type: 'wisp',
				domain: 'alice.wisp.place',
				domain_id: null,
				domain_verified: null,
			},
			{
				did: 'did:example:alice',
				rkey: 'first',
				display_name: 'first',
				created_at: 100,
				updated_at: 200,
				domain_type: 'custom',
				domain: 'example.com',
				domain_id: 'custom-1',
				domain_verified: true,
			},
			{
				did: 'did:example:alice',
				rkey: 'first',
				display_name: 'first',
				created_at: 100,
				updated_at: 200,
				domain_type: 'custom',
				domain: 'pending.example.com',
				domain_id: 'custom-2',
				domain_verified: false,
			},
			{
				did: 'did:example:alice',
				rkey: 'second',
				display_name: 'second',
				created_at: 50,
				updated_at: 60,
				domain_type: null,
				domain: null,
				domain_id: null,
				domain_verified: null,
			},
		]
		const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
			calls.push({ text: strings.join('?'), values })
			return Promise.resolve(rows)
		}) as unknown as SQL

		const queries = createPresentationReadQueries(sql)
		const sites = await queries.getSitesWithDomainsByDid('did:example:alice')

		expect(calls).toHaveLength(1)
		expect(calls[0]?.text).toContain('LEFT JOIN LATERAL')
		expect(calls[0]?.values).toEqual(['did:example:alice', DELETED_SITE_RECORD_CID])
		expect(sites).toEqual([
			{
				did: 'did:example:alice',
				rkey: 'first',
				display_name: 'first',
				created_at: 100,
				updated_at: 200,
				domains: [
					{ type: 'wisp', domain: 'alice.wisp.place' },
					{ type: 'custom', id: 'custom-1', domain: 'example.com', verified: true },
					{ type: 'custom', id: 'custom-2', domain: 'pending.example.com', verified: false },
				],
			},
			{
				did: 'did:example:alice',
				rkey: 'second',
				display_name: 'second',
				created_at: 50,
				updated_at: 60,
				domains: [],
			},
		])
	})
})
