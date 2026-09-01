import { beforeEach, describe, expect, mock, test } from 'bun:test'

const promotedKeys: string[] = []
const failingKeys = new Set<string>()
let listKeysCalls = 0

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
	triggerSiteHtmlHotCacheWarmup(DID, RKEY, paths)
	return waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)
}

describe('HTML prewarm', () => {
	beforeEach(() => {
		promotedKeys.length = 0
		failingKeys.clear()
		listKeysCalls = 0
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

	test('legacy callers without a manifest do not trigger a storage scan', async () => {
		triggerSiteHtmlHotCacheWarmup(DID, RKEY)
		await waitForSiteHtmlHotCacheWarmupForTests(DID, RKEY)

		expect(promotedKeys).toHaveLength(0)
		expect(listKeysCalls).toBe(0)
	})
})
