import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SiteCache } from '@wispplace/database'

// The module binds its pool at import, so give it a fake postgres whose reads
// fail with the queued errors before they return a row.
const row: SiteCache = { did: 'did:plc:a', rkey: 'site', record_cid: 'cid', file_cids: {}, cached_at: 0, updated_at: 0 }
let queued: Error[] = []
let queries = 0
mock.module('postgres', () => ({
	default: () =>
		Object.assign(
			async () => {
				queries++
				const error = queued.shift()
				if (error) throw error
				return [row]
			},
			{ end: async () => {} },
		),
}))
const { getSiteCache } = await import('./db')

const withCode = (code: string) => Object.assign(new Error(`write ${code} 10.88.0.4:15433`), { code })

describe('hosting replica reads', () => {
	beforeEach(() => {
		queued = []
		queries = 0
	})

	test('survive a pooled connection that was already closed', async () => {
		queued = [withCode('CONNECTION_CLOSED')]

		expect(await getSiteCache('did:plc:a', 'closed-once')).toEqual(row)
		expect(queries).toBe(2)
	})

	test('stop retrying a database that keeps dropping connections', async () => {
		queued = Array.from({ length: 10 }, () => withCode('CONNECTION_CLOSED'))

		await expect(getSiteCache('did:plc:a', 'closed-always')).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
		expect(queries).toBe(3)
	})

	test('do not retry an error from the query itself', async () => {
		queued = [withCode('42P01')]

		await expect(getSiteCache('did:plc:a', 'query-error')).rejects.toMatchObject({ code: '42P01' })
		expect(queries).toBe(1)
	})
})
