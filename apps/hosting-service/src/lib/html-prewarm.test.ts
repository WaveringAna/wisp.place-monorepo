import { beforeEach, describe, expect, mock, test } from 'bun:test'

const cachedKeys = new Set<string>()
const promotedKeys: string[] = []
/** Keys whose read throws, standing in for a concurrent invalidation removing one mid-scan. */
const failingKeys = new Set<string>()

const fakeStorage = {
	async getWithMetadata(key: string) {
		promotedKeys.push(key)
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
	async *listKeys(prefix?: string): AsyncIterableIterator<string> {
		for (const key of cachedKeys) {
			if (!prefix || key.startsWith(prefix)) {
				yield key
			}
		}
	},
}

mock.module('./storage', () => ({
	storage: fakeStorage,
}))

const {
	resetHtmlHotCacheWarmupForTests,
	resetSiteHtmlHotCacheWarmup,
	triggerSiteHtmlHotCacheWarmup,
	waitForSiteHtmlHotCacheWarmupForTests,
} = await import('./html-prewarm')

const DID = 'did:plc:test'
const RKEY = 'site'

describe('HTML prewarm', () => {
	beforeEach(() => {
		cachedKeys.clear()
		promotedKeys.length = 0
		failingKeys.clear()
		resetHtmlHotCacheWarmupForTests()
	})

	// A concurrent deletePrefix() can rename a site's directory away mid-scan, so a read
	// that already passed listKeys can still fail. That must not cost the rest of the site.
	test('one failing key does not abort the rest of the site', async () => {
		cachedKeys.add(`${DID}/${RKEY}/index.html`)
		cachedKeys.add(`${DID}/${RKEY}/a.html`)
		cachedKeys.add(`${DID}/${RKEY}/b.html`)
		failingKeys.add(`${DID}/${RKEY}/a.html`)

		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)

		expect(promotedKeys.sort()).toEqual(
			[`${DID}/${RKEY}/a.html`, `${DID}/${RKEY}/b.html`, `${DID}/${RKEY}/index.html`].sort(),
		)
	})

	// The regression that mattered most: a thrown key skipped warmedSites.add(), so every
	// later request re-ran the full listing forever.
	test('a partially failed scan still marks the site warm', async () => {
		cachedKeys.add(`${DID}/${RKEY}/index.html`)
		cachedKeys.add(`${DID}/${RKEY}/a.html`)
		failingKeys.add(`${DID}/${RKEY}/a.html`)

		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)
		expect(promotedKeys).toHaveLength(2)

		// Second request must not rescan.
		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)
		expect(promotedKeys).toHaveLength(2)
	})

	test('loads all HTML keys for a site on first hit', async () => {
		cachedKeys.add(`${DID}/${RKEY}/index.html`)
		cachedKeys.add(`${DID}/${RKEY}/nested/about.htm`)
		cachedKeys.add(`${DID}/${RKEY}/docs/guide.HTML`)
		cachedKeys.add(`${DID}/${RKEY}/style.css`)
		cachedKeys.add(`${DID}/other-site/index.html`)

		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)

		expect(promotedKeys.sort()).toEqual(
			[`${DID}/${RKEY}/docs/guide.HTML`, `${DID}/${RKEY}/index.html`, `${DID}/${RKEY}/nested/about.htm`].sort(),
		)

		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)

		expect(promotedKeys).toHaveLength(3)
	})

	test('reset allows a site to be prewarmed again', async () => {
		cachedKeys.add(`${DID}/${RKEY}/index.html`)

		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)
		expect(promotedKeys).toHaveLength(1)

		resetSiteHtmlHotCacheWarmup(DID, RKEY)

		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)
		expect(promotedKeys).toHaveLength(2)
	})

	test('site with no cached keys is marked warm after a successful empty scan', async () => {
		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)
		expect(promotedKeys).toHaveLength(0)

		cachedKeys.add(`${DID}/${RKEY}/index.html`)

		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)
		expect(promotedKeys).toHaveLength(0)
	})
})
