import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import type { PublicSite, Site } from './model'
import { deployedChange, overlayChanges, type SiteChange, waitUntilSettled } from './site-sync'

const site = (rkey: string, recordCid: string, extra: Partial<PublicSite> = {}): PublicSite => ({
	kind: 'public',
	key: `public:${rkey}`,
	rkey,
	name: rkey,
	createdAt: 1_000,
	updatedAt: 1_000,
	domains: [],
	recordCid,
	...extra,
})

const deleted = (rkey: string): SiteChange => ({ kind: 'deleted', key: `public:${rkey}`, name: rkey })
const deployed = (rkey: string, cid: string): SiteChange => ({ kind: 'deployed', rkey, cid, at: 5_000 })
const rkeys = (sites: readonly Site[]) => sites.map((entry) => (entry.kind === 'public' ? entry.rkey : entry.siteId))

describe('site list overlay', () => {
	test('hides a deleted site the server still lists, and waits for it', () => {
		const { sites, waiting } = overlayChanges([site('blog', 'c1'), site('zine', 'c2')], [deleted('blog')])
		expect(rkeys(sites)).toEqual(['zine'])
		expect(waiting).toEqual([deleted('blog')])
	})

	test('stops waiting once the server list no longer has the deleted site', () => {
		const change = deleted('blog')
		expect(overlayChanges([site('zine', 'c2')], [change]).waiting).toEqual([])
	})

	test('lists a new site as deploying until the server lists its record', () => {
		const change = deployed('fresh', 'c9')
		const before = overlayChanges([site('zine', 'c2')], [change])
		expect(before.sites[0]).toMatchObject({ rkey: 'fresh', deploying: true, createdAt: 5_000 })
		expect(before.waiting).toEqual([change])

		const after = overlayChanges([site('fresh', 'c9'), site('zine', 'c2')], [change])
		expect(after.waiting).toEqual([])
		expect(after.sites[0]).toEqual(site('fresh', 'c9'))
	})

	test('keeps an updated site deploying while the server still has its old record', () => {
		const domains = [{ type: 'custom' as const, domain: 'blog.example' }]
		const { sites, waiting } = overlayChanges([site('blog', 'old', { domains })], [deployed('blog', 'new')])
		expect(sites).toEqual([site('blog', 'old', { domains, updatedAt: 5_000, recordCid: undefined, deploying: true })])
		expect(waiting).toHaveLength(1)
	})

	test('is idempotent, so a refetch while waiting does not stack placeholders', () => {
		const changes = [deployed('fresh', 'c9'), deleted('zine')]
		const once = overlayChanges([site('zine', 'c2')], changes).sites
		expect(overlayChanges(once, changes).sites).toEqual(once)
	})
})

describe('deployedChange', () => {
	test('reads the rkey and cid of the manifest a public upload wrote', () => {
		expect(deployedChange({ uri: 'at://did:plc:abc/place.wisp.fs/my-site', cid: 'bafy' }, 7)).toEqual({
			kind: 'deployed',
			rkey: 'my-site',
			cid: 'bafy',
			at: 7,
		})
	})

	test('ignores uploads that wrote no site manifest', () => {
		expect(deployedChange({}, 7)).toBeNull()
		expect(deployedChange({ uri: 'at://did:plc:abc/place.wisp.subfs/x', cid: 'bafy' }, 7)).toBeNull()
	})
})

describe('waitUntilSettled', () => {
	beforeEach(() => jest.useFakeTimers())
	afterEach(() => jest.useRealTimers())

	const flush = async () => {
		for (let i = 0; i < 20; i++) await Promise.resolve()
	}

	test('checks after 1 s, then 2 s, and stops as soon as it is settled', async () => {
		const checks: number[] = []
		let elapsed = 0
		const done = waitUntilSettled(async () => {
			checks.push(elapsed)
			return checks.length === 2
		})
		for (const step of [999, 1, 1999, 1]) {
			elapsed += step
			jest.advanceTimersByTime(step)
			await flush()
		}
		expect(await done).toBe(true)
		expect(checks).toEqual([1000, 3000])

		jest.advanceTimersByTime(60_000)
		await flush()
		expect(checks).toHaveLength(2)
	})

	test('gives up after 60 s instead of looping forever', async () => {
		let checks = 0
		let result: boolean | undefined
		void waitUntilSettled(async () => {
			checks++
			return false
		}).then((settled) => {
			result = settled
		})
		for (let second = 0; second < 59; second++) {
			jest.advanceTimersByTime(1000)
			await flush()
		}
		expect(result).toBeUndefined()
		jest.advanceTimersByTime(1000)
		await flush()
		expect(result).toBe(false)
		expect(checks).toBe(11)
	})
})
