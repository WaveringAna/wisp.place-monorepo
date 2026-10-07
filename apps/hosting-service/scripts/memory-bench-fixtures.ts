/**
 * Deterministic sites and objects for scripts/memory-bench.ts.
 *
 * Manifest rows are rebuilt on every query, so the bench fixtures hold no
 * per-site memory in the server process.
 */
import { gzipSync } from 'node:zlib'
import { computeCID } from '@wispplace/atproto-utils'
import { casKey } from '@wispplace/fs-utils'

export const BENCH_BASE_HOST = 'bench.test'

type ObjectKind = 'index' | 'html' | 'css' | 'js' | 'img' | 'video' | 'bigHtml'

interface KindSpec {
	count: number
	ext: string
	mimeType: string
	gzip: boolean
	minBytes: number
	maxBytes: number
}

const KINDS: Record<Exclude<ObjectKind, 'index'>, KindSpec> = {
	html: { count: 40, ext: 'html', mimeType: 'text/html', gzip: true, minBytes: 3_000, maxBytes: 40_000 },
	css: { count: 10, ext: 'css', mimeType: 'text/css', gzip: true, minBytes: 5_000, maxBytes: 60_000 },
	js: { count: 20, ext: 'js', mimeType: 'text/javascript', gzip: true, minBytes: 20_000, maxBytes: 400_000 },
	img: { count: 40, ext: 'webp', mimeType: 'image/webp', gzip: false, minBytes: 10_000, maxBytes: 400_000 },
	video: { count: 4, ext: 'mp4', mimeType: 'video/mp4', gzip: false, minBytes: 3 << 20, maxBytes: 16 << 20 },
	bigHtml: { count: 2, ext: 'html', mimeType: 'text/html', gzip: true, minBytes: 2 << 20, maxBytes: 4 << 20 },
}

export type ObjectPool<T extends PoolRef = PoolRef> = Record<ObjectKind, T[]>

/** What a manifest needs to name an object. */
export interface PoolRef {
	cid: string
	key: string
}

export interface PoolObject extends PoolRef {
	kind: ObjectKind
	mimeType: string
	encoding?: 'gzip'
	stored: Uint8Array
	uncompressedSize: number
}

export interface ManifestEntry {
	path: string
	kind: ObjectKind
	index: number
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const WORDS = 'wisp place static site atproto blob manifest cache tier edge docs post'.split(' ')

function textBody(kind: ObjectKind, size: number, random: () => number): Uint8Array {
	const parts: string[] = []
	let length = 0
	if (kind === 'html' || kind === 'bigHtml')
		parts.push('<!doctype html><html><head><link rel="stylesheet" href="/assets/style.css"></head><body>')
	while (length < size) {
		const word = WORDS[Math.floor(random() * WORDS.length)] ?? 'wisp'
		const chunk =
			kind === 'js'
				? `const ${word}${length}=${Math.floor(random() * 1e6)};`
				: `<p><a href="/${word}/${length}">${word}</a> ${word}</p>`
		parts.push(chunk)
		length += chunk.length
	}
	return new TextEncoder().encode(parts.join(''))
}

function binaryBody(size: number, random: () => number): Uint8Array {
	const bytes = new Uint8Array(size)
	for (let offset = 0; offset < size; offset += 4) {
		const value = Math.floor(random() * 4294967296)
		bytes[offset] = value & 0xff
		bytes[offset + 1] = (value >>> 8) & 0xff
		bytes[offset + 2] = (value >>> 16) & 0xff
		bytes[offset + 3] = value >>> 24
	}
	return bytes
}

/** Each site's own home page; every other path shares a pooled object. */
const INDEX_KIND: KindSpec = {
	count: 0,
	ext: 'html',
	mimeType: 'text/html',
	gzip: true,
	minBytes: 2_000,
	maxBytes: 30_000,
}

function kindSpec(kind: ObjectKind, siteCount: number): KindSpec {
	return kind === 'index' ? { ...INDEX_KIND, count: siteCount } : KINDS[kind]
}

/** Every object a bench manifest can reference, built from a fixed seed. */
export function buildObjectPool(siteCount: number): ObjectPool<PoolObject> {
	const random = mulberry32(0x5eed)
	const pool = {} as ObjectPool<PoolObject>
	for (const kind of ['index', ...Object.keys(KINDS)] as ObjectKind[]) {
		const spec = kindSpec(kind, siteCount)
		pool[kind] = Array.from({ length: spec.count }, () => {
			const size = Math.floor(spec.minBytes + random() * (spec.maxBytes - spec.minBytes))
			const raw = spec.gzip ? textBody(kind, size, random) : binaryBody(size, random)
			const stored = spec.gzip ? new Uint8Array(gzipSync(raw)) : raw
			const cid = computeCID(raw)
			const encoding = spec.gzip ? ('gzip' as const) : undefined
			const key = casKey({ cid, path: `x.${spec.ext}`, mimeType: spec.mimeType, encoding })
			return { kind, cid, key, mimeType: spec.mimeType, encoding, stored, uncompressedSize: raw.byteLength }
		})
	}
	return pool
}

export function siteHost(site: number): string {
	return `s${site}.${BENCH_BASE_HOST}`
}

export function siteFromHost(host: string): number | null {
	const match = /^s(\d+)\./.exec(host)
	return match ? Number(match[1]) : null
}

export function siteDid(site: number): string {
	const letters = String(site)
		.split('')
		.map((digit) => 'abcdefghij'[Number(digit)])
		.join('')
	return `did:plc:${letters.padStart(24, 'z')}`
}

export function siteRkey(site: number): string {
	return `site-${site}`
}

/** 1% of sites carry 1000 files, 9% carry 200, the rest 25. */
export function siteFileCount(site: number): number {
	if (site % 100 === 0) return 1000
	if (site % 10 === 0) return 200
	return 25
}

export function siteHasVideo(site: number): boolean {
	return site % 50 === 7
}

function siteHasBigIndex(site: number): boolean {
	return site % 200 === 3
}

export function siteManifest(site: number): ManifestEntry[] {
	const pick = (kind: Exclude<ObjectKind, 'index'>, salt: number) => (site * 31 + salt * 7) % KINDS[kind].count
	const entries: ManifestEntry[] = [
		siteHasBigIndex(site)
			? { path: 'index.html', kind: 'bigHtml', index: pick('bigHtml', 0) }
			: { path: 'index.html', kind: 'index', index: site },
		{ path: 'assets/style.css', kind: 'css', index: pick('css', 1) },
		{ path: 'assets/app.js', kind: 'js', index: pick('js', 2) },
	]
	if (siteHasVideo(site)) entries.push({ path: 'media/video.mp4', kind: 'video', index: pick('video', 3) })
	for (let file = entries.length; file < siteFileCount(site); file++) {
		if (file % 3 === 0) entries.push({ path: `posts/post-${file}/index.html`, kind: 'html', index: pick('html', file) })
		else if (file % 3 === 1) entries.push({ path: `img/photo-${file}.webp`, kind: 'img', index: pick('img', file) })
		else entries.push({ path: `assets/chunk-${file}.js`, kind: 'js', index: pick('js', file) })
	}
	return entries
}

/** The `site_cache` row hosting reads for one site. */
export function siteCacheRow(site: number, pool: ObjectPool) {
	const fileCids: Record<string, string> = {}
	const fileObjects: Record<string, string> = {}
	for (const entry of siteManifest(site)) {
		const object = pool[entry.kind][entry.index]
		if (!object) continue
		fileCids[entry.path] = object.cid
		fileObjects[entry.path] = object.key
	}
	return {
		did: siteDid(site),
		rkey: siteRkey(site),
		record_cid: `bafyrecord${site}`,
		file_cids: fileCids,
		file_objects: fileObjects,
		cached_at: 0,
		updated_at: 0,
		absent_since: null,
	}
}
