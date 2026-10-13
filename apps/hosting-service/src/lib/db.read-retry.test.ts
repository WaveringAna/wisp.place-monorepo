import { beforeEach, describe, expect, test } from 'bun:test'
import type { SiteCache } from '@wispplace/database'
import { CacheManager } from './cache-manager'
import { createHostingDb, type HostingSql } from './db'

// Postgres is the one piece faked here: reads fail with the queued errors before
// they return a row. The retry and the lookup cache are the real ones.
const row: SiteCache = { did: 'did:plc:a', rkey: 'site', record_cid: 'cid', file_cids: {}, cached_at: 0, updated_at: 0 }
let queued: Error[] = []
let queries = 0
const sql = (async () => {
	queries++
	const error = queued.shift()
	if (error) throw error
	return [row]
}) as unknown as HostingSql
const { getSiteCache } = createHostingDb({
	sql,
	cache: new CacheManager({ domains: {}, customDomains: {}, settings: {}, siteCache: {} }),
})

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
