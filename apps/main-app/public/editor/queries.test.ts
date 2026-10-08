import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { notifyManager } from '@tanstack/react-query'
import type { PublicSiteRecord } from './api'
import type { Site } from './model'
import { expectSiteChange, keys, queryClient, sitesQuery } from './queries'
import { noticeStore } from './store'

// Notify synchronously so fake timers only have to drive the dashboard's own backoff.
notifyManager.setScheduler((callback) => callback())

const record = (rkey: string, record_cid = `cid-${rkey}`): PublicSiteRecord => ({
	did: 'did:plc:alice',
	rkey,
	display_name: rkey,
	record_cid,
	created_at: 1,
	updated_at: 1,
	domains: [],
})

/** What GET /api/user/sites answers: the firehose-built list, which trails the PDS. */
let listed: PublicSiteRecord[] = []
let requests: string[] = []
const realFetch = globalThis.fetch

const fakeFetch = async (input: string | URL | Request) => {
	const url = String(input)
	requests.push(url)
	const body = url.startsWith('/api/user/private-sites') ? { sites: [] } : { sites: listed }
	return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response
}

const cached = () => (queryClient.getQueryData<Site[]>(keys.sites) ?? []).map((site) => site.name)
const siteRequests = () => requests.filter((url) => url.startsWith('/api/user/sites'))

const flush = async () => {
	for (let i = 0; i < 50; i++) await Promise.resolve()
}
const advance = async (ms: number) => {
	jest.advanceTimersByTime(ms)
	await flush()
}

beforeEach(async () => {
	globalThis.fetch = fakeFetch as typeof fetch
	queryClient.clear()
	noticeStore.set(null)
	listed = [record('blog'), record('zine')]
	await queryClient.fetchQuery(sitesQuery)
	requests = []
	jest.useFakeTimers()
})

afterEach(() => {
	jest.useRealTimers()
	globalThis.fetch = realFetch
})

describe('site list after a delete', () => {
	test('drops the site at once and keeps it gone while refetches are still stale', async () => {
		const done = expectSiteChange({ kind: 'deleted', key: 'public:blog', name: 'blog' })
		await flush()
		expect(cached()).toEqual(['zine'])

		// The firehose has not processed the delete yet: the first refetch still lists it.
		await advance(1000)
		expect(siteRequests()).toEqual(['/api/user/sites?fresh=1'])
		expect(cached()).toEqual(['zine'])

		listed = [record('zine')]
		await advance(2000)
		await done
		expect(cached()).toEqual(['zine'])
		expect(siteRequests()).toHaveLength(2)

		// Settled: no more polling, and normal loads go back to the replica.
		await advance(60_000)
		expect(siteRequests()).toHaveLength(2)
		await queryClient.refetchQueries({ queryKey: keys.sites })
		expect(siteRequests()[siteRequests().length - 1]).toBe('/api/user/sites')
		expect(noticeStore.get()).toBeNull()
	})

	test('gives up after a minute and shows what the server lists, with a notice', async () => {
		let finished = false
		void expectSiteChange({ kind: 'deleted', key: 'public:blog', name: 'blog' }).then(() => {
			finished = true
		})
		await flush()
		for (let second = 0; second < 59; second++) await advance(1000)
		expect(finished).toBe(false)
		await advance(1000)
		expect(finished).toBe(true)
		expect(cached()).toEqual(['blog', 'zine'])
		expect(siteRequests()).toHaveLength(12)
		expect(noticeStore.get()?.text).toContain('blog')
	})
})

describe('site list after a deploy', () => {
	test('lists a new site as deploying until the server lists its record', async () => {
		const done = expectSiteChange({ kind: 'deployed', rkey: 'fresh', cid: 'cid-new', at: Date.now() })
		await flush()
		const deploying = () => queryClient.getQueryData<Site[]>(keys.sites)?.find((site) => site.name === 'fresh')
		expect(deploying()).toMatchObject({ deploying: true })

		await advance(1000)
		expect(deploying()).toMatchObject({ deploying: true })

		listed = [record('fresh', 'cid-new'), ...listed]
		await advance(2000)
		await done
		expect(deploying()).toMatchObject({ recordCid: 'cid-new' })
		expect(deploying()).not.toHaveProperty('deploying')
	})

	test('keeps a new site listed through a 43 s firehose lag', async () => {
		const done = expectSiteChange({ kind: 'deployed', rkey: 'slow', cid: 'cid-slow', at: Date.now() })
		const slow = () => queryClient.getQueryData<Site[]>(keys.sites)?.find((site) => site.name === 'slow')
		await flush()
		for (let second = 0; second < 43; second++) {
			await advance(1000)
			expect(slow()).toMatchObject({ deploying: true })
		}
		listed = [record('slow', 'cid-slow'), ...listed]
		await advance(1000)
		await done
		expect(slow()).toMatchObject({ recordCid: 'cid-slow' })
		expect(noticeStore.get()).toBeNull()
	})

	test('waits for the new record when the server still has the old one', async () => {
		const done = expectSiteChange({ kind: 'deployed', rkey: 'blog', cid: 'cid-blog-2', at: Date.now() })
		const blog = () => queryClient.getQueryData<Site[]>(keys.sites)?.find((site) => site.name === 'blog')
		await flush()
		await advance(1000)
		await advance(2000)
		expect(blog()).toMatchObject({ deploying: true })

		listed = [record('blog', 'cid-blog-2'), record('zine')]
		await advance(3000)
		await done
		expect(blog()).toMatchObject({ recordCid: 'cid-blog-2' })
		expect(siteRequests()).toHaveLength(3)
	})
})
