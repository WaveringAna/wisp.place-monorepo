import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SiteCache } from '@wispplace/database'
import { casKey } from '@wispplace/fs-utils'
import type { HostingWarmMirrorOutcome } from '@wispplace/observability'
import { DiskStorageTier, MemoryStorageTier, type StorageMetadata, TieredStorage } from '@wispplace/tiered-storage'
import { StorageUnavailableError } from './storage'
import {
	createWarmMirror,
	resolveWarmMirrorConfig,
	siteMirrorKeys,
	startWarmMirror,
	type WarmMirror,
	type WarmMirrorDependencies,
} from './warm-mirror'

const DID = 'did:plc:mirror'

function metadata(key: string, size: number): StorageMetadata {
	return {
		key,
		size,
		createdAt: new Date(),
		lastAccessed: new Date(),
		accessCount: 0,
		compressed: false,
		checksum: 'x',
	}
}

/** A site row whose every path has a distinct CAS key, as the firehose writes them. */
function site(rkey: string, paths: string[], extra: Partial<SiteCache> = {}): SiteCache {
	const cid = (path: string) => `bafkrei${Buffer.from(`${rkey}/${path}`).toString('hex')}`
	return {
		did: DID,
		rkey,
		record_cid: 'record',
		file_cids: Object.fromEntries(paths.map((path) => [path, cid(path)])),
		file_objects: Object.fromEntries(paths.map((path) => [path, casKey({ cid: cid(path), path })])),
		cached_at: 0,
		updated_at: 0,
		absent_since: null,
		...extra,
	}
}

const casOf = (row: SiteCache, path: string) => (row.file_objects as Record<string, string>)[path] as string

class FakeScheduler {
	readonly entries: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = []
	readonly schedule = (callback: () => void, delayMs: number) => {
		const entry = { callback, delayMs, cancelled: false }
		this.entries.push(entry)
		return () => {
			entry.cancelled = true
		}
	}

	get active() {
		return this.entries.filter((entry) => !entry.cancelled)
	}

	fireAll(): void {
		for (const entry of this.active) {
			entry.cancelled = true
			entry.callback()
		}
	}
}

let directory: string
let hot: MemoryStorageTier
let warm: DiskStorageTier
let cold: MemoryStorageTier
let coldReads: string[]
let failingKeys: Set<string>
let coldError: Error | null
let rows: SiteCache[]
let takenDown: Set<string>
let updating: Set<string>
let recorded: Array<[HostingWarmMirrorOutcome, number]>
let scheduler: FakeScheduler
let mirror: WarmMirror | null

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'warm-mirror-'))
	hot = new MemoryStorageTier({ maxSizeBytes: 1024 * 1024 })
	warm = new DiskStorageTier({ directory, maxSizeBytes: 1024 * 1024 })
	// Finish the tier's startup scan before a test can remove its directory.
	await warm.exists('init/probe')
	cold = new MemoryStorageTier({ maxSizeBytes: 64 * 1024 * 1024 })
	coldReads = []
	failingKeys = new Set()
	coldError = null
	const coldGetStream = cold.getStream.bind(cold)
	cold.getStream = async (key, options) => {
		coldReads.push(key)
		if (coldError) throw coldError
		if (failingKeys.has(key)) throw new Error('read failed')
		return coldGetStream(key, options)
	}
	// Any other cold access (buffered reads, HEADs, listings) is a bug for the mirror.
	for (const method of ['get', 'getWithMetadata', 'exists', 'getMetadata', 'listKeys'] as const) {
		;(cold as unknown as Record<string, unknown>)[method] = () => {
			throw new Error(`warm mirror called cold.${method}`)
		}
	}
	rows = []
	takenDown = new Set()
	updating = new Set()
	recorded = []
	scheduler = new FakeScheduler()
	mirror = null
})

afterEach(async () => {
	await mirror?.stop()
	await rm(directory, { recursive: true, force: true })
})

function storage(): TieredStorage<Uint8Array> {
	return new TieredStorage<Uint8Array>({
		tiers: { hot, warm, cold },
		promotionStrategy: 'eager',
		// Every key is hot-eligible, so any promotion into memory would show up.
		placementRules: [{ pattern: '**', tiers: ['hot', 'warm', 'cold'] }],
		serialization: { serialize: async (data) => data as Uint8Array, deserialize: async (data) => data },
	})
}

async function putCold(key: string, size = 100): Promise<void> {
	await cold.set(key, new Uint8Array(size).fill(1), metadata(key, size))
}

function createMirror(overrides: Partial<WarmMirrorDependencies> = {}): WarmMirror {
	mirror = createWarmMirror({
		storage: storage(),
		warmHas: (key) => warm.exists(key),
		warmUsage: () => ({ usedBytes: warm.getIndexedBytes(), maxBytes: 1024 * 1024 }),
		listSites: async (afterDid, afterRkey, limit) =>
			rows
				.filter((row) => row.did > afterDid || (row.did === afterDid && row.rkey > afterRkey))
				.sort((a, b) => (a.rkey < b.rkey ? -1 : 1))
				.slice(0, limit),
		getSite: async (did, rkey) => rows.find((row) => row.did === did && row.rkey === rkey) ?? null,
		isTakenDown: (_did, rkey) => takenDown.has(rkey),
		isSiteUpdating: (_did, rkey) => updating.has(rkey),
		record: (outcome, bytes) => recorded.push([outcome, bytes]),
		config: { concurrency: 2, fillPercent: 80 },
		schedule: scheduler.schedule,
		updateDelayMs: 0,
		pageSize: 2,
		...overrides,
	})
	return mirror
}

async function runStartupPass(overrides: Partial<WarmMirrorDependencies> = {}): Promise<WarmMirror> {
	const created = createMirror(overrides)
	created.start()
	await created.settled()
	return created
}

const outcomes = () => recorded.map(([outcome]) => outcome).sort()

describe('resolveWarmMirrorConfig', () => {
	test('is off unless WARM_MIRROR is exactly true', () => {
		for (const value of [undefined, '', 'false', '1', 'yes', 'TRUE']) {
			expect(resolveWarmMirrorConfig({ WARM_MIRROR: value })).toBeNull()
		}
		expect(resolveWarmMirrorConfig({ WARM_MIRROR: 'true' })).toEqual({ concurrency: 2, fillPercent: 80 })
	})

	test('bounds concurrency to 1..16 and the fill share to 1..95 percent', () => {
		const config = (concurrency: string, fill: string) =>
			resolveWarmMirrorConfig({
				WARM_MIRROR: 'true',
				WARM_MIRROR_CONCURRENCY: concurrency,
				WARM_MIRROR_FILL_PERCENT: fill,
			})
		expect(config('16', '95')).toEqual({ concurrency: 16, fillPercent: 95 })
		expect(config('1', '1')).toEqual({ concurrency: 1, fillPercent: 1 })
		for (const [concurrency, fill] of [
			['0', '0'],
			['17', '96'],
			['2.5', 'abc'],
		] as const) {
			expect(config(concurrency, fill)).toEqual({ concurrency: 2, fillPercent: 80 })
		}
	})

	test('with the flag off nothing is created', () => {
		expect(startWarmMirror({})).toBeNull()
		expect(startWarmMirror({ WARM_MIRROR: 'false' })).toBeNull()
	})
})

describe('siteMirrorKeys', () => {
	test('names each manifest body and the pre-rewritten copy of each HTML page', () => {
		const row = site('blog', ['index.html', 'style.css', 'img/a.png'])
		const keys = siteMirrorKeys(DID, 'blog', {
			fileCids: row.file_cids,
			fileObjects: row.file_objects as Record<string, string>,
		})
		expect(keys.sort()).toEqual(
			[
				casOf(row, 'index.html'),
				casOf(row, 'style.css'),
				casOf(row, 'img/a.png'),
				`${DID}/blog/.rewritten/index.html`,
			].sort(),
		)
	})

	test('skips paths serving would not read: no stored body, no manifest CID, or a derived copy', () => {
		const keys = siteMirrorKeys(DID, 'blog', {
			fileCids: { 'unconverted.png': 'bafkreiaaaa', 'empty.png': '', '.rewritten/index.html': 'bafkreibbbb' },
			fileObjects: { 'empty.png': casKey({ cid: 'bafkreicccc', path: 'empty.png' }) },
		})
		expect(keys).toEqual([])
	})
})

describe('warm mirror startup pass', () => {
	test('copies missing keys into warm and skips warm ones without reading cold', async () => {
		const row = site('a', ['style.css', 'img/a.png', 'img/b.png'])
		rows = [row]
		for (const path of ['style.css', 'img/a.png', 'img/b.png']) await putCold(casOf(row, path))
		const present = casOf(row, 'img/a.png')
		await warm.set(present, new Uint8Array(100), metadata(present, 100))
		const touched: string[] = []
		warm.recordAccess = (key) => touched.push(key)

		await runStartupPass()

		expect(coldReads.sort()).toEqual([casOf(row, 'style.css'), casOf(row, 'img/b.png')].sort())
		for (const path of ['style.css', 'img/a.png', 'img/b.png']) expect(await warm.exists(casOf(row, path))).toBe(true)
		expect(outcomes()).toEqual(['already-warm', 'fetched', 'fetched'])
		expect(recorded.filter(([outcome]) => outcome === 'fetched').map(([, bytes]) => bytes)).toEqual([100, 100])
		// Checking a present key must not count as a visit, or every pass would reset the LRU order.
		expect(touched).toEqual([])
	})

	test('a second pass over a mirrored edge issues no cold reads', async () => {
		const row = site('a', ['style.css', 'img/a.png'])
		rows = [row]
		for (const path of ['style.css', 'img/a.png']) await putCold(casOf(row, path))
		await runStartupPass()
		await mirror?.stop()
		coldReads = []
		recorded = []

		await runStartupPass()

		expect(coldReads).toEqual([])
		expect(outcomes()).toEqual(['already-warm', 'already-warm'])
	})

	test('never promotes into the hot tier', async () => {
		const row = site('a', ['index.html', 'app.js'])
		rows = [row]
		const keys = [casOf(row, 'index.html'), casOf(row, 'app.js'), `${DID}/a/.rewritten/index.html`]
		for (const key of keys) await putCold(key)

		await runStartupPass()

		for (const key of keys) {
			expect(await warm.exists(key)).toBe(true)
			expect(await hot.exists(key)).toBe(false)
		}
		expect((await hot.getStats()).items).toBe(0)
	})

	test('skips taken-down, deleted and mid-update sites', async () => {
		const live = site('live', ['a.png'])
		const takenDownSite = site('banned', ['b.png'])
		const deleted = site('gone', ['c.png'], { absent_since: 1_700_000_000 })
		const midUpdate = site('moving', ['d.png'])
		rows = [live, takenDownSite, deleted, midUpdate]
		for (const row of rows) for (const path of Object.keys(row.file_cids)) await putCold(casOf(row, path))
		takenDown.add('banned')
		updating.add('moving')

		await runStartupPass()

		expect(coldReads).toEqual([casOf(live, 'a.png')])
		expect(await warm.exists(casOf(takenDownSite, 'b.png'))).toBe(false)
		expect(await warm.exists(casOf(deleted, 'c.png'))).toBe(false)
		expect(await warm.exists(casOf(midUpdate, 'd.png'))).toBe(false)
	})

	test('a CAS body shared by several sites is checked once', async () => {
		const first = site('a', ['logo.png'])
		const second = { ...site('b', []), file_cids: first.file_cids, file_objects: first.file_objects }
		rows = [first, second]
		await putCold(casOf(first, 'logo.png'))

		await runStartupPass()

		expect(coldReads).toEqual([casOf(first, 'logo.png')])
		expect(outcomes()).toEqual(['fetched'])
	})

	test('one failing key does not stop the pass', async () => {
		const row = site('a', ['1.png', '2.png', '3.png', '4.png'])
		rows = [row]
		for (const path of Object.keys(row.file_cids)) await putCold(casOf(row, path))
		failingKeys.add(casOf(row, '2.png'))
		// And one key the object store no longer has.
		await cold.delete(casOf(row, '3.png'))

		await runStartupPass()

		expect(outcomes()).toEqual(['failed', 'fetched', 'fetched', 'skipped'])
		expect(await warm.exists(casOf(row, '1.png'))).toBe(true)
		expect(await warm.exists(casOf(row, '4.png'))).toBe(true)
		expect(await readdir(join(directory, '.staging')).catch(() => [])).toEqual([])
	})

	test('stops at its share of the warm tier instead of churning it', async () => {
		const paths = Array.from({ length: 10 }, (_, index) => `${index}.png`)
		const row = site('a', paths)
		rows = [row]
		for (const path of paths) await putCold(casOf(row, path), 100)

		// 50% of 1000 bytes: room for five 100-byte objects.
		await runStartupPass({
			warmUsage: () => ({ usedBytes: warm.getIndexedBytes(), maxBytes: 1000 }),
			config: { concurrency: 1, fillPercent: 50 },
		})

		expect(warm.getIndexedBytes()).toBe(500)
		expect(recorded.filter(([outcome]) => outcome === 'fetched')).toHaveLength(5)
		// The sixth read sees the budget and is dropped; nothing after it is read.
		expect(coldReads).toHaveLength(6)
		expect(scheduler.active).toHaveLength(0)
	})

	test('stops and retries later once the cold tier breaker is open', async () => {
		const row = site('a', ['1.png', '2.png', '3.png'])
		rows = [row]
		for (const path of Object.keys(row.file_cids)) await putCold(casOf(row, path))
		coldError = new StorageUnavailableError('getStream', 'circuit-open')

		const created = await runStartupPass({ config: { concurrency: 1, fillPercent: 80 }, retryDelayMs: 1234 })

		expect(coldReads).toHaveLength(1)
		expect(scheduler.active.map((entry) => entry.delayMs)).toEqual([1234])

		coldError = null
		coldReads = []
		scheduler.fireAll()
		await created.settled()
		expect(coldReads).toHaveLength(3)
		for (const path of Object.keys(row.file_cids)) expect(await warm.exists(casOf(row, path))).toBe(true)
	})

	test('stop aborts an in-flight pass and leaves no partial objects', async () => {
		const paths = Array.from({ length: 20 }, (_, index) => `${index}.png`)
		const row = site('a', paths)
		rows = [row]
		for (const path of paths) await putCold(casOf(row, path))
		let releaseFirstRead: () => void = () => {}
		const firstReadStarted = new Promise<void>((resolve) => {
			const getStream = cold.getStream
			cold.getStream = async (key, options) => {
				resolve()
				await new Promise<void>((release) => {
					releaseFirstRead = release
				})
				return getStream(key, options)
			}
		})

		const created = createMirror()
		created.start()
		await firstReadStarted
		const stopped = created.stop()
		releaseFirstRead()
		await stopped

		expect(coldReads.length).toBeLessThan(paths.length)
		expect(await readdir(join(directory, '.staging')).catch(() => [])).toEqual([])
		expect(scheduler.active).toHaveLength(0)
	})

	test('waits for its ready promise before reading anything', async () => {
		rows = [site('a', ['1.png'])]
		await putCold(casOf(rows[0] as SiteCache, '1.png'))
		let ready: () => void = () => {}
		const created = createMirror()
		created.start(new Promise<void>((resolve) => (ready = resolve)))
		await Promise.resolve()
		expect(coldReads).toEqual([])
		ready()
		await created.settled()
		expect(coldReads).toHaveLength(1)
	})
})

describe('warm mirror site updates', () => {
	test('mirror only the updated site, once per burst of events', async () => {
		const other = site('other', ['x.png'])
		const updated = site('a', ['old.png', 'new.png'])
		rows = [other, updated]
		await putCold(casOf(other, 'x.png'))
		await putCold(casOf(updated, 'new.png'))
		const old = casOf(updated, 'old.png')
		await warm.set(old, new Uint8Array(100), metadata(old, 100))
		let siteLoads = 0
		mirror = createMirror({
			getSite: async (did, rkey) => {
				siteLoads++
				return rows.find((row) => row.did === did && row.rkey === rkey) ?? null
			},
		})

		mirror.queueSite(DID, 'a')
		mirror.queueSite(DID, 'a')
		mirror.queueSite(DID, 'a')
		expect(scheduler.active).toHaveLength(1)
		scheduler.fireAll()
		await mirror.settled()

		expect(siteLoads).toBe(1)
		expect(coldReads).toEqual([casOf(updated, 'new.png')])
		expect(await warm.exists(casOf(other, 'x.png'))).toBe(false)
		expect(outcomes()).toEqual(['already-warm', 'fetched'])
	})

	test('a site still downloading is tried again after the delay', async () => {
		const row = site('a', ['1.png'])
		rows = [row]
		await putCold(casOf(row, '1.png'))
		const created = createMirror()
		updating.add('a')

		created.queueSite(DID, 'a')
		scheduler.fireAll()
		await created.settled()
		expect(coldReads).toEqual([])
		expect(scheduler.active).toHaveLength(1)

		updating.delete('a')
		scheduler.fireAll()
		await created.settled()
		expect(coldReads).toEqual([casOf(row, '1.png')])
	})

	test('an update for a taken-down site fetches nothing', async () => {
		const row = site('a', ['1.png'])
		rows = [row]
		await putCold(casOf(row, '1.png'))
		takenDown.add('a')
		const created = createMirror()

		created.queueSite(DID, 'a')
		scheduler.fireAll()
		await created.settled()

		expect(coldReads).toEqual([])
	})
})
