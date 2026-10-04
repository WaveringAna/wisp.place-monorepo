import { describe, expect, mock, test } from 'bun:test'
import { DELETED_SITE_RECORD_CID } from '@wispplace/constants'

mock.module('./db', () => ({ db: async () => [] }))
mock.module('./redis', () => ({ getConnectedRedisClient: async () => null }))

const { sitesToBackfill } = await import('./pds-backfill')

describe('sitesToBackfill', () => {
	test('queues sites the cache is missing, stale, deleted, or still waiting for files', () => {
		const records = [
			{ rkey: 'fresh', cid: 'bafy-1' },
			{ rkey: 'missing', cid: 'bafy-2' },
			{ rkey: 'stale', cid: 'bafy-new' },
			{ rkey: 'resurrected', cid: 'bafy-4' },
		]
		const synced = (recordCid: string) => ({ recordCid, coldSynced: true })
		const cached = new Map([
			['fresh', synced('bafy-1')],
			['stale', synced('bafy-old')],
			['resurrected', synced(DELETED_SITE_RECORD_CID)],
			['seeded', { recordCid: 'bafy-5', coldSynced: false }],
			['gone-from-pds', synced('bafy-9')],
		])
		expect(sitesToBackfill([...records, { rkey: 'seeded', cid: 'bafy-5' }], cached).map((site) => site.rkey)).toEqual([
			'missing',
			'stale',
			'resurrected',
			'seeded',
		])
	})
})
