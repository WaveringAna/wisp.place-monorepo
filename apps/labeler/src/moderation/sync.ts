import { createLogger } from '@wispplace/observability'
import type postgres from 'postgres'
import type { ModerationStore, PublishedSite } from './store'

const logger = createLogger('moderation-sync')
const BATCH = 500
const HANDLE_TTL_MS = 24 * 3600_000

/** A position in site_cache order: (updated_at, did, rkey). */
export type SyncPosition = { updatedAt: number; did: string; rkey: string }
export const encodePosition = (p: SyncPosition) => JSON.stringify([p.updatedAt, p.did, p.rkey])
export function decodePosition(value: string | null): SyncPosition {
	if (!value) return { updatedAt: 0, did: '', rkey: '' }
	const [updatedAt, did, rkey] = JSON.parse(value) as [number, string, string]
	return { updatedAt, did, rkey }
}

/**
 * Sites whose site_cache row changed after `after`, with their domains. The order
 * is total, so a batch boundary inside one second neither skips nor repeats rows.
 */
export async function readPublished(sql: postgres.Sql, after: SyncPosition, limit = BATCH): Promise<PublishedSite[]> {
	const rows = await sql<
		{
			did: string
			rkey: string
			record_cid: string
			updated_at: string
			absent: boolean
			files: number
			subdomains: string[] | null
			custom: string[] | null
		}[]
	>`
		SELECT sc.did, sc.rkey, sc.record_cid, sc.updated_at::text, sc.absent_since IS NOT NULL AS absent,
			(SELECT count(*) FROM jsonb_object_keys(sc.file_cids))::int AS files,
			(SELECT array_agg(d.domain ORDER BY d.domain) FROM domains d WHERE d.did = sc.did AND d.rkey = sc.rkey) AS subdomains,
			(SELECT array_agg(c.domain ORDER BY c.domain) FROM custom_domains c
				WHERE c.did = sc.did AND c.rkey = sc.rkey AND c.verified) AS custom
		FROM site_cache sc
		WHERE (sc.updated_at, sc.did, sc.rkey) > (${after.updatedAt}, ${after.did}, ${after.rkey})
		ORDER BY sc.updated_at, sc.did, sc.rkey
		LIMIT ${limit}`
	return rows.map((r) => ({
		did: r.did,
		rkey: r.rkey,
		recordCid: r.record_cid,
		updatedAt: Number(r.updated_at),
		absent: r.absent,
		files: r.files,
		subdomains: r.subdomains ?? [],
		custom: r.custom ?? [],
	}))
}

export type HandleResolver = (did: string) => Promise<string | null>

/** The handle in a DID document's alsoKnownAs, from plc.directory or the did:web host. */
export const resolveHandleFromDidDoc: HandleResolver = async (did) => {
	const url = did.startsWith('did:web:')
		? `https://${decodeURIComponent(did.slice(8))}/.well-known/did.json`
		: `https://plc.directory/${did}`
	const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
	if (!res.ok) return null
	const doc = (await res.json()) as { alsoKnownAs?: string[] }
	return doc.alsoKnownAs?.find((a) => a.startsWith('at://'))?.slice(5) ?? null
}

/** Where a site is served: a verified custom domain, a wisp subdomain, or the shared host. */
export function siteUrl(site: PublishedSite, handle: string, sharedHost: string): string {
	const host = site.custom[0] ?? site.subdomains[0]
	return host ? `https://${host}/` : `https://${sharedHost}/${handle || site.did}/${site.rkey}/`
}

/**
 * Brings moderation_sites up to date with site_cache: new sites and new record
 * versions become pending subjects for the model.
 */
export function createSiteSync({
	sql,
	store,
	resolveHandle = resolveHandleFromDidDoc,
	sharedHost = 'sites.wisp.place',
}: {
	sql: postgres.Sql
	store: ModerationStore
	resolveHandle?: HandleResolver
	sharedHost?: string
}) {
	const handles = new Map<string, { handle: string; at: number }>()

	async function handleOf(did: string): Promise<string> {
		const cached = handles.get(did)
		if (cached && Date.now() - cached.at < HANDLE_TTL_MS) return cached.handle
		const handle = (await resolveHandle(did).catch(() => null)) ?? cached?.handle ?? ''
		handles.set(did, { handle, at: Date.now() })
		return handle
	}

	/** One pass: read up to a batch of changes, upsert them, advance the cursor. Returns rows read. */
	async function syncOnce(): Promise<number> {
		const published = await readPublished(sql, decodePosition(await store.cursor('site_cache')))
		if (published.length === 0) return 0
		const withNames = []
		for (const site of published) {
			const handle = await handleOf(site.did)
			withNames.push({ ...site, handle, url: siteUrl(site, handle, sharedHost) })
		}
		const seen = await store.upsertSites(withNames)
		const last = published[published.length - 1]
		if (last) await store.saveCursor('site_cache', encodePosition(last))
		if (seen) logger.info('New site versions', { seen })
		return published.length
	}

	return {
		syncOnce,
		/** Drain everything outstanding, a batch at a time. */
		async syncAll(): Promise<void> {
			while ((await syncOnce()) === BATCH) {}
		},
	}
}
