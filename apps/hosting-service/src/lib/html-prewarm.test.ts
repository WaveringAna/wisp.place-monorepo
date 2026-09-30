import { beforeEach, describe, expect, mock, test } from 'bun:test'

const promotedKeys: string[] = []
const failingKeys = new Set<string>()
let listKeysCalls = 0
let blockWarmupReads = false
let blockedWarmupReads = 0
const releaseWarmupReads: Array<() => void> = []

const fakeStorage = {
	async getWithMetadata(key: string) {
		promotedKeys.push(key)
		if (blockWarmupReads && blockedWarmupReads < 2) {
			blockedWarmupReads++
			await new Promise<void>((resolve) => releaseWarmupReads.push(resolve))
		}
		if (failingKeys.has(key)) {
			throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
		}
		return {
			data: new Uint8Array([1]),
			metadata: {
				key,
				size: 1,
				createdAt: new Date(),
				lastAccessed: new Date(),
				accessCount: 0,
				checksum: 'checksum',
			},
			source: 'cold' as const,
		}
	},
	listKeys(): AsyncIterableIterator<string> {
		listKeysCalls++
		return {
			next: async () => {
				throw new Error('manifest-backed prewarm must not list storage')
			},
			[Symbol.asyncIterator]() {
				return this
			},
		} as AsyncIterableIterator<string>
	},
}

mock.module('./storage', () => ({ storage: fakeStorage }))

const {
	resetHtmlHotCacheWarmupForTests,
	resetSiteHtmlHotCacheWarmup,
	triggerSiteHtmlHotCacheWarmup,
	waitForSiteHtmlHotCacheWarmupForTests,
} = await import('./html-prewarm')

const DID = 'did:plc:test'
const RKEY = 'site'
const key = (path: string) => `${DID}/${RKEY}/${path}`

function warmup(paths: readonly string[]): Promise<void> {
	return warmupSite(DID, RKEY, paths)
}

function warmupSite(did: string, rkey: string, paths: readonly string[]): Promise<void> {
	triggerSiteHtmlHotCacheWarmup(did, rkey, paths)
	return waitForSiteHtmlHotCacheWarmupForTests(did, rkey)
}

describe('HTML prewarm', () => {
	beforeEach(() => {
		promotedKeys.length = 0
		failingKeys.clear()
		listKeysCalls = 0
		blockWarmupReads = false
		blockedWarmupReads = 0
		releaseWarmupReads.length = 0
		resetHtmlHotCacheWarmupForTests()
	})

	test('warms only HTML paths from the authoritative manifest without listing storage', async () => {
		await warmup([
			'index.html',
			'nested/about.htm',
			'docs/guide.HTML',
			'style.css',
			'_redirects',
			'.rewritten/index.html',
			'.metadata.json',
		])

		expect(promotedKeys.sort()).toEqual([key('docs/guide.HTML'), key('index.html'), key('nested/about.htm')].sort())
		expect(listKeysCalls).toBe(0)
	})

	test('normalizes leading slashes before excluding rewritten and metadata paths', async () => {
		await warmup(['/.rewritten/foo.html', '/.metadata.json', '/nested/page.html'])

		expect(promotedKeys).toEqual([key('nested/page.html')])
	})

	test('one failing key does not abort the rest of the manifest', async () => {
		failingKeys.add(key('a.html'))
		await warmup(['index.html', 'a.html', 'b.html'])

		expect(promotedKeys.sort()).toEqual([key('a.html'), key('b.html'), key('index.html')].sort())
	})

	test('a partially failed warmup still marks the site warm', async () => {
		failingKeys.add(key('a.html'))
		await warmup(['index.html', 'a.html'])
		expect(promotedKeys).toHaveLength(2)

		await warmup(['index.html', 'a.html'])
		expect(promotedKeys).toHaveLength(2)
	})

	test('reset allows a site to be prewarmed again', async () => {
		await warmup(['index.html'])
		expect(promotedKeys).toHaveLength(1)

		resetSiteHtmlHotCacheWarmup(DID, RKEY)
		await warmup(['index.html'])
		expect(promotedKeys).toHaveLength(2)
	})

	test('bounds concurrent warmups and reset cannot bypass admission', async () => {
		blockWarmupReads = true
		triggerSiteHtmlHotCacheWarmup(DID, 'active-0', ['index.html'])
		triggerSiteHtmlHotCacheWarmup(DID, 'active-1', ['index.html'])
		await Promise.resolve()
		expect(blockedWarmupReads).toBe(2)

		const first = waitForSiteHtmlHotCacheWarmupForTests(DID, 'active-0')
		resetSiteHtmlHotCacheWarmup(DID, 'active-0')

		// Forgetting active work must not release its admission slot.
		triggerSiteHtmlHotCacheWarmup(DID, 'skipped', ['index.html'])
		resetSiteHtmlHotCacheWarmup(DID, 'skipped')
		triggerSiteHtmlHotCacheWarmup(DID, 'skipped', ['index.html'])
		await Promise.resolve()
		expect(promotedKeys).toHaveLength(2)

		for (const release of releaseWarmupReads.splice(0)) release()
		await first
		await waitForSiteHtmlHotCacheWarmupForTests(DID, 'active-1')

		await warmupSite(DID, 'skipped', ['index.html'])
		expect(promotedKeys).toHaveLength(3)
	})

	test('stale warmup completion cannot mark a reset site warm or clear newer work', async () => {
		blockWarmupReads = true
		triggerSiteHtmlHotCacheWarmup(DID, RKEY, ['index.html'])
		await Promise.resolve()
		expect(blockedWarmupReads).toBe(1)
		const stale = waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)

		resetSiteHtmlHotCacheWarmup(DID, RKEY)
		triggerSiteHtmlHotCacheWarmup(DID, RKEY, ['index.html'])
		await Promise.resolve()
		expect(blockedWarmupReads).toBe(2)
		const fresh = waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)

		// Resolve the stale read first. The fresh entry remains pending, so a
		// request now must deduplicate rather than start a third read.
		releaseWarmupReads.shift()!()
		await stale
		expect(promotedKeys).toHaveLength(2)
		triggerSiteHtmlHotCacheWarmup(DID, RKEY, ['index.html'])
		await Promise.resolve()
		expect(promotedKeys).toHaveLength(2)

		releaseWarmupReads.shift()!()
		await fresh
		await warmup(['index.html'])
		expect(promotedKeys).toHaveLength(2)
	})

	test('bounds completed per-site warmup bookkeeping', async () => {
		for (let index = 0; index < 1_001; index++) {
			await warmupSite(DID, `site-${index}`, ['index.html'])
		}

		await warmupSite(DID, 'site-0', ['index.html'])
		expect(promotedKeys).toHaveLength(1_002)
	})

	test('legacy callers without a manifest do not trigger a storage scan', async () => {
		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)

		expect(promotedKeys).toHaveLength(0)
		expect(listKeysCalls).toBe(0)
	})
})
