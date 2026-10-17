import type postgres from 'postgres'
import type {
	AccountView,
	ActiveLabel,
	ModerationEvent,
	QueueView,
	SiteSummary,
	SubjectState,
	Triage,
	Verdict,
	VerdictRecord,
} from './types'

/** One site_cache row with its domains, as the sync reads it. */
export type PublishedSite = {
	did: string
	rkey: string
	recordCid: string
	updatedAt: number
	absent: boolean
	files: number
	subdomains: string[]
	custom: string[]
}

export type PageFacts = { title: string; excerpt: string; outbound: string[] }

type SiteRow = {
	uri: string
	did: string
	rkey: string
	handle: string
	url: string
	domains: string[]
	title: string
	excerpt: string
	outbound: string[]
	files: number
	first_seen: Date
	updated: Date
	deleted: boolean
	state: 'pending' | 'clear' | 'flagged'
	triage: Triage | null
	covered: boolean
	sv_verdict: Verdict | null
	sv_note: string | null
	sv_moderator: string | null
	sv_at: Date | null
	av_verdict: Verdict | null
	av_note: string | null
	av_moderator: string | null
	av_at: Date | null
	labels: ActiveLabel[]
}

export const siteUri = (did: string, rkey: string) => `at://${did}/place.wisp.fs/${rkey}`

const verdictRecord = (
	value: Verdict | null,
	note: string | null,
	by: string | null,
	at: Date | null,
	scope: 'site' | 'account',
): VerdictRecord | null => (value && at ? { value, note: note ?? '', by: by ?? '', at: at.toISOString(), scope } : null)

function toSummary(row: SiteRow): SiteSummary {
	const verdict =
		verdictRecord(row.sv_verdict, row.sv_note, row.sv_moderator, row.sv_at, 'site') ??
		verdictRecord(row.av_verdict, row.av_note, row.av_moderator, row.av_at, 'account')
	const state: SubjectState = row.covered ? 'reviewed' : row.state
	return {
		uri: row.uri,
		did: row.did,
		rkey: row.rkey,
		handle: row.handle || row.did,
		url: row.url,
		domains: row.domains,
		title: row.title,
		excerpt: row.excerpt,
		outbound: row.outbound,
		files: row.files,
		firstSeen: row.first_seen.toISOString(),
		updated: row.updated.toISOString(),
		deleted: row.deleted,
		state,
		verdict,
		triage: row.triage,
		labels: row.labels,
	}
}

/** Keyset cursor over (updated DESC, uri). */
export const encodeCursor = (updated: string, uri: string) => Buffer.from(`${updated}|${uri}`).toString('base64url')
export function decodeCursor(cursor: string | null | undefined): { updated: string; uri: string } | null {
	if (!cursor) return null
	const [updated, uri] = Buffer.from(cursor, 'base64url').toString().split('|')
	return updated && uri && !Number.isNaN(Date.parse(updated)) ? { updated, uri } : null
}

const MAX_LIMIT = 100

/**
 * The moderation tables. Every read is one query; labels come from the labeler's
 * own log in the same database, so nothing here waits on the network.
 */
export function createModerationStore(sql: postgres.Sql, labelerDid: string) {
	// The newest label per (uri, val) from this labeler that is neither negated nor expired.
	const activeLabels = sql`
		active_labels AS (
			SELECT uri, val, cts FROM (
				SELECT DISTINCT ON (uri, val) uri, val, cts, neg, exp FROM labeler_labels
				WHERE src = ${labelerDid}
				ORDER BY uri, val, seq DESC
			) newest
			WHERE NOT neg AND (exp IS NULL OR exp::timestamptz > now())
		)`

	// A verdict covers a site version when it was given after that version was published;
	// the site's own verdict wins over its account's.
	const covered = sql`(COALESCE(sv.at, av.at) >= s.updated)`
	const takenDown = sql`EXISTS (SELECT 1 FROM active_labels t WHERE t.val = '!takedown' AND t.uri IN (s.uri, s.did))`

	const summaries = (
		where: postgres.PendingQuery<postgres.Row[]>,
		order: postgres.PendingQuery<postgres.Row[]>,
		limit: number,
	) =>
		sql<SiteRow[]>`
			WITH ${activeLabels}
			SELECT s.uri, s.did, s.rkey, s.handle, s.url, s.domains, s.title, s.excerpt, s.outbound, s.files,
				s.first_seen, s.updated, s.deleted, s.state, s.triage,
				COALESCE(${covered}, false) AS covered,
				sv.verdict AS sv_verdict, sv.note AS sv_note, sv.moderator AS sv_moderator, sv.at AS sv_at,
				av.verdict AS av_verdict, av.note AS av_note, av.moderator AS av_moderator, av.at AS av_at,
				COALESCE((SELECT json_agg(json_build_object('uri', l.uri, 'val', l.val, 'cts', l.cts) ORDER BY l.cts)
					FROM active_labels l WHERE l.uri IN (s.uri, s.did)), '[]'::json) AS labels
			FROM moderation_sites s
			LEFT JOIN moderation_verdicts sv ON sv.subject = s.uri
			LEFT JOIN moderation_verdicts av ON av.subject = s.did
			WHERE ${where}
			${order}
			LIMIT ${limit}`

	function viewFilter(view: QueueView) {
		switch (view) {
			case 'flagged':
				return sql`s.state = 'flagged' AND NOT s.deleted AND NOT COALESCE(${covered}, false) AND NOT ${takenDown}`
			case 'pending':
				return sql`s.state = 'pending' AND NOT s.deleted`
			case 'recent':
				return sql`NOT s.deleted`
			case 'reviewed':
				return sql`COALESCE(${covered}, false)`
		}
	}

	async function site(uri: string): Promise<SiteSummary | null> {
		const [row] = await summaries(sql`s.uri = ${uri}`, sql``, 1)
		return row ? toSummary(row) : null
	}

	/** Newest first. With `did`, only that account's events and its sites'. */
	async function events(cursor: string | null, limit: number, did?: string) {
		const before = cursor && /^\d+$/.test(cursor) ? Number(cursor) : null
		const size = Math.min(Math.max(limit, 1), MAX_LIMIT)
		const rows = await sql<
			{
				id: string
				subject: string
				kind: ModerationEvent['kind']
				actor: string
				data: Record<string, unknown>
				at: Date
				handle: string | null
				title: string | null
			}[]
		>`
			SELECT e.id, e.subject, e.kind, e.actor, e.data, e.at,
				(SELECT NULLIF(s.handle, '') FROM moderation_sites s WHERE s.uri = e.subject OR s.did = e.subject LIMIT 1) AS handle,
				(SELECT NULLIF(s.title, '') FROM moderation_sites s WHERE s.uri = e.subject) AS title
			FROM moderation_events e
			WHERE ${before ? sql`e.id < ${before}` : sql`true`}
			${did ? sql`AND (e.subject = ${did} OR e.subject LIKE ${`at://${did}/%`})` : sql``}
			ORDER BY e.id DESC LIMIT ${size}`
		const items: ModerationEvent[] = rows.map((r) => ({ ...r, id: Number(r.id), at: r.at.toISOString() }))
		const last = items[items.length - 1]
		return { items, cursor: items.length === size && last ? String(last.id) : null }
	}

	async function event(subject: string, kind: ModerationEvent['kind'], actor: string, data: Record<string, unknown>) {
		await sql`INSERT INTO moderation_events (subject, kind, actor, data) VALUES (${subject}, ${kind}, ${actor}, ${sql.json(data as postgres.JSONValue)})`
	}

	return {
		site,
		event,

		async queue(view: QueueView, cursor: string | null, limit: number) {
			const after = decodeCursor(cursor)
			const size = Math.min(Math.max(limit, 1), MAX_LIMIT)
			const page = sql`${viewFilter(view)} ${
				after ? sql`AND (s.updated, s.uri) < (${after.updated}::timestamptz, ${after.uri})` : sql``
			}`
			const rows = await summaries(page, sql`ORDER BY s.updated DESC, s.uri DESC`, size)
			const last = rows[rows.length - 1]
			return {
				items: rows.map(toSummary),
				cursor: rows.length === size && last ? encodeCursor(last.updated.toISOString(), last.uri) : null,
			}
		},

		async counts(): Promise<Record<QueueView, number>> {
			const [row] = await sql<Record<QueueView, string>[]>`
				WITH ${activeLabels}
				SELECT
					count(*) FILTER (WHERE ${viewFilter('flagged')}) AS flagged,
					count(*) FILTER (WHERE ${viewFilter('pending')}) AS pending,
					count(*) FILTER (WHERE ${viewFilter('recent')}) AS recent,
					count(*) FILTER (WHERE ${viewFilter('reviewed')}) AS reviewed
				FROM moderation_sites s
				LEFT JOIN moderation_verdicts sv ON sv.subject = s.uri
				LEFT JOIN moderation_verdicts av ON av.subject = s.did`
			return {
				flagged: Number(row?.flagged ?? 0),
				pending: Number(row?.pending ?? 0),
				recent: Number(row?.recent ?? 0),
				reviewed: Number(row?.reviewed ?? 0),
			}
		},

		async search(q: string, limit = 50): Promise<SiteSummary[]> {
			const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`
			const rows = await summaries(
				sql`(s.did = ${q} OR s.handle ILIKE ${like} OR s.url ILIKE ${like} OR s.title ILIKE ${like}
					OR array_to_string(s.domains, ' ') ILIKE ${like} OR s.rkey ILIKE ${like})`,
				sql`ORDER BY s.updated DESC, s.uri DESC`,
				Math.min(limit, MAX_LIMIT),
			)
			return rows.map(toSummary)
		},

		async account(did: string): Promise<AccountView> {
			const [rows, [verdict], labels, recent] = await Promise.all([
				summaries(sql`s.did = ${did}`, sql`ORDER BY s.updated DESC, s.uri DESC`, MAX_LIMIT),
				sql<{ verdict: Verdict; note: string; moderator: string; at: Date }[]>`
					SELECT verdict, note, moderator, at FROM moderation_verdicts WHERE subject = ${did}`,
				sql<
					ActiveLabel[]
				>`WITH ${activeLabels} SELECT uri, val, cts FROM active_labels WHERE uri = ${did} ORDER BY cts`,
				events(null, 50, did),
			])
			const sites = rows.map(toSummary)
			return {
				did,
				handle: sites[0]?.handle ?? did,
				verdict: verdict
					? verdictRecord(verdict.verdict, verdict.note, verdict.moderator, verdict.at, 'account')
					: null,
				labels,
				sites,
				events: recent.items,
			}
		},

		events,

		async setVerdict(subject: string, verdict: Verdict | null, note: string, moderator: string) {
			if (verdict === null) await sql`DELETE FROM moderation_verdicts WHERE subject = ${subject}`
			else
				await sql`
					INSERT INTO moderation_verdicts (subject, verdict, note, moderator, at)
					VALUES (${subject}, ${verdict}, ${note}, ${moderator}, now())
					ON CONFLICT (subject) DO UPDATE SET verdict = EXCLUDED.verdict, note = EXCLUDED.note,
						moderator = EXCLUDED.moderator, at = EXCLUDED.at`
			await event(subject, 'verdict', moderator, { verdict, note })
		},

		/** Active labels on these subjects (site URIs or DIDs). */
		async labelsOn(subjects: readonly string[]): Promise<ActiveLabel[]> {
			return sql<ActiveLabel[]>`
				WITH ${activeLabels}
				SELECT uri, val, cts FROM active_labels WHERE uri = ANY(${subjects as string[]}) ORDER BY cts`
		},

		/**
		 * Upsert published sites. A new record version (a different record CID) goes
		 * back to `pending` for the model and is logged as seen.
		 */
		async upsertSites(sites: readonly (PublishedSite & { handle: string; url: string })[]) {
			let seen = 0
			for (const p of sites) {
				const uri = siteUri(p.did, p.rkey)
				// prev is read from the snapshot before the upsert, so it holds the old record CID
				const [row] = await sql<{ prev_cid: string | null }[]>`
					WITH prev AS (SELECT record_cid FROM moderation_sites WHERE uri = ${uri})
					INSERT INTO moderation_sites (uri, did, rkey, record_cid, handle, url, domains, files, updated, deleted)
					VALUES (${uri}, ${p.did}, ${p.rkey}, ${p.recordCid}, ${p.handle}, ${p.url},
						${[...p.custom, ...p.subdomains]}, ${p.files}, to_timestamp(${p.updatedAt}), ${p.absent})
					ON CONFLICT (uri) DO UPDATE SET
						handle = EXCLUDED.handle, url = EXCLUDED.url, domains = EXCLUDED.domains, files = EXCLUDED.files,
						deleted = EXCLUDED.deleted,
						updated = CASE WHEN moderation_sites.record_cid = EXCLUDED.record_cid
							THEN moderation_sites.updated ELSE EXCLUDED.updated END,
						state = CASE WHEN moderation_sites.record_cid = EXCLUDED.record_cid
							THEN moderation_sites.state ELSE 'pending' END,
						triage = CASE WHEN moderation_sites.record_cid = EXCLUDED.record_cid
							THEN moderation_sites.triage ELSE NULL END,
						triage_attempts = CASE WHEN moderation_sites.record_cid = EXCLUDED.record_cid
							THEN moderation_sites.triage_attempts ELSE 0 END,
						triage_after = CASE WHEN moderation_sites.record_cid = EXCLUDED.record_cid
							THEN moderation_sites.triage_after ELSE now() END,
						record_cid = EXCLUDED.record_cid
					RETURNING (SELECT record_cid FROM prev) AS prev_cid`
				const fresh = row !== undefined && row.prev_cid !== p.recordCid
				if (fresh) {
					seen++
					await event(uri, 'seen', 'system', {
						recordCid: p.recordCid,
						updated: new Date(p.updatedAt * 1000).toISOString(),
					})
				}
			}
			return seen
		},

		/** Sites whose rows left site_cache (the record was deleted). */
		async markMissingDeleted() {
			const rows = await sql`
				UPDATE moderation_sites s SET deleted = true
				WHERE NOT s.deleted AND NOT EXISTS (SELECT 1 FROM site_cache c WHERE c.did = s.did AND c.rkey = s.rkey)
				RETURNING uri`
			return rows.length
		},

		async cursor(name: string): Promise<string | null> {
			const [row] = await sql<{ value: string }[]>`SELECT value FROM moderation_cursor WHERE name = ${name}`
			return row?.value ?? null
		},
		async saveCursor(name: string, value: string) {
			await sql`
				INSERT INTO moderation_cursor (name, value) VALUES (${name}, ${value})
				ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`
		},

		/** The next site version for the model, newest first, skipping ones waiting out a retry. */
		async nextPending(): Promise<{
			uri: string
			did: string
			rkey: string
			handle: string
			files: number
			attempts: number
		} | null> {
			const [row] = await sql<
				{ uri: string; did: string; rkey: string; handle: string; files: number; triage_attempts: number }[]
			>`
				SELECT uri, did, rkey, handle, files, triage_attempts FROM moderation_sites
				WHERE state = 'pending' AND NOT deleted AND triage_after <= now()
				ORDER BY updated DESC LIMIT 1`
			return row ? { ...row, attempts: row.triage_attempts } : null
		},
		async deferTriage(uri: string, attempts: number, delaySeconds: number) {
			await sql`
				UPDATE moderation_sites SET triage_attempts = ${attempts},
					triage_after = now() + make_interval(secs => ${delaySeconds})
				WHERE uri = ${uri}`
		},
		async saveTriage(uri: string, triage: Triage, page: PageFacts | null) {
			await sql`
				UPDATE moderation_sites SET state = ${triage.flag ? 'flagged' : 'clear'}, triage = ${sql.json(triage)},
					title = COALESCE(${page?.title ?? null}, title), excerpt = COALESCE(${page?.excerpt ?? null}, excerpt),
					outbound = COALESCE(${page?.outbound ?? null}, outbound)
				WHERE uri = ${uri}`
			await event(uri, 'triaged', `model:${triage.model}`, { ...triage })
		},
	}
}

export type ModerationStore = ReturnType<typeof createModerationStore>
