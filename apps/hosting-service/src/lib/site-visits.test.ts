import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSiteVisits, siteVisitsFile } from './site-visits'

let directory: string
let file: string
let clock: number

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'site-visits-'))
	file = join(directory, 'site-visits.json')
	clock = 1_000
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

const visits = (maxSites?: number) => createSiteVisits({ file, maxSites, now: () => clock++ })
const sites = (list: Array<{ did: string; rkey: string }>) => list.map(({ did, rkey }) => `${did}/${rkey}`)

describe('site visits', () => {
	test('lists sites most recently visited first, once each', () => {
		const v = visits()
		v.record('did:plc:a', 'one')
		v.record('did:plc:b', 'two')
		v.record('did:plc:a', 'one')
		expect(sites(v.recent())).toEqual(['did:plc:a/one', 'did:plc:b/two'])
	})

	test('forgets the least recently visited site past its limit', () => {
		const v = visits(2)
		v.record('did:plc:a', 'one')
		v.record('did:plc:a', 'two')
		v.record('did:plc:a', 'one')
		v.record('did:plc:a', 'three')
		expect(sites(v.recent())).toEqual(['did:plc:a/three', 'did:plc:a/one'])
	})

	test('survives a restart through its file, keeping visits since the restart newest', async () => {
		const before = visits()
		before.record('did:plc:a', 'old')
		before.record('did:plc:a', 'older-but-revisited')
		await before.flush()

		const after = visits()
		after.record('did:plc:a', 'new')
		await after.load()
		expect(sites(after.recent())).toEqual(['did:plc:a/new', 'did:plc:a/older-but-revisited', 'did:plc:a/old'])
	})

	test('writes only when something changed', async () => {
		const v = visits()
		await v.flush()
		await expect(readFile(file, 'utf8')).rejects.toThrow()
		v.record('did:plc:a', 'one')
		await v.flush()
		await writeFile(file, 'sentinel')
		await v.flush()
		expect(await readFile(file, 'utf8')).toBe('sentinel')
	})

	test('a damaged or foreign file starts empty instead of failing', async () => {
		for (const content of ['not json', '{"did":"x"}', '[{"did":1,"rkey":"a","at":1}]']) {
			await writeFile(file, content)
			const v = visits()
			await v.load()
			expect(v.recent()).toEqual([])
		}
	})

	test('lives beside the warm cache directory unless set explicitly', () => {
		expect(siteVisitsFile({ CACHE_DIR: '/cache/sites' })).toBe('/cache/site-visits.json')
		expect(siteVisitsFile({ WISP_SITE_VISITS_FILE: '/tmp/v.json', CACHE_DIR: '/cache/sites' })).toBe('/tmp/v.json')
	})
})
