import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createLogger } from '@wispplace/observability'

const logger = createLogger('site-visits')

const DEFAULT_MAX_SITES = 50_000
const DEFAULT_FLUSH_INTERVAL_MS = 60_000

export interface SiteVisit {
	did: string
	rkey: string
	/** Epoch milliseconds of the site's most recent visit on this edge. */
	at: number
}

export interface SiteVisits {
	/** Note a visit to one site; cheap enough for every request. */
	record(did: string, rkey: string): void
	/** Visited sites, most recent first. */
	recent(): SiteVisit[]
	/** Read the file written by an earlier process; a missing or damaged file starts empty. */
	load(): Promise<void>
	/** Write the visits to disk if any changed since the last write. */
	flush(): Promise<void>
	/** Flush every interval until the returned function is called. */
	startFlushing(intervalMs?: number): () => void
}

/**
 * When each site was last visited on this edge, so background work (the warm
 * mirror) can favour what this edge's visitors actually read. Insertion order is
 * kept as recency order, so the oldest entries go first past `maxSites`. The
 * file is replaced atomically, so a crash leaves the previous copy.
 */
export function createSiteVisits(options: { file: string; maxSites?: number; now?: () => number }): SiteVisits {
	const { file, maxSites = DEFAULT_MAX_SITES, now = Date.now } = options
	const visits = new Map<string, SiteVisit>()
	let dirty = false
	let writing: Promise<void> | null = null

	function put(visit: SiteVisit): void {
		const key = `${visit.did}/${visit.rkey}`
		visits.delete(key)
		visits.set(key, visit)
		while (visits.size > maxSites) {
			const oldest = visits.keys().next().value
			if (oldest === undefined) break
			visits.delete(oldest)
		}
	}

	async function write(): Promise<void> {
		if (!dirty) return
		dirty = false
		const temporary = `${file}.${process.pid}.tmp`
		try {
			await mkdir(dirname(file), { recursive: true })
			await writeFile(temporary, JSON.stringify([...visits.values()]))
			await rename(temporary, file)
		} catch (error) {
			dirty = true
			logger.warn('Could not save site visits', { errorName: error instanceof Error ? error.name : 'UnknownError' })
		}
	}

	async function flush(): Promise<void> {
		while (writing) await writing
		writing = write().finally(() => {
			writing = null
		})
		await writing
	}

	return {
		record(did, rkey) {
			put({ did, rkey, at: now() })
			dirty = true
		},
		recent() {
			return [...visits.values()].reverse()
		},
		async load() {
			let saved: unknown
			try {
				saved = JSON.parse(await readFile(file, 'utf8'))
			} catch {
				return
			}
			if (!Array.isArray(saved)) return
			const loaded = saved.filter(
				(entry): entry is SiteVisit =>
					typeof entry?.did === 'string' && typeof entry?.rkey === 'string' && Number.isFinite(entry?.at),
			)
			// Visits recorded before the load stay newest.
			const current = [...visits.values()]
			visits.clear()
			for (const visit of loaded.sort((a, b) => a.at - b.at)) put(visit)
			for (const visit of current) put(visit)
		},
		flush,
		startFlushing(intervalMs = DEFAULT_FLUSH_INTERVAL_MS) {
			const timer = setInterval(() => void flush(), intervalMs)
			timer.unref?.()
			return () => clearInterval(timer)
		},
	}
}

/** This process's visits, saved beside the warm cache directory on the same volume. */
export const siteVisits = createSiteVisits({ file: siteVisitsFile(process.env) })

/** The file beside the warm cache directory, on the same volume as the cache itself. */
export function siteVisitsFile(env: Readonly<Record<string, string | undefined>>): string {
	return env.WISP_SITE_VISITS_FILE || resolve(env.CACHE_DIR || './cache/sites', '..', 'site-visits.json')
}
