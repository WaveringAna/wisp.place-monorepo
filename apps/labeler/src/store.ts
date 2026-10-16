import { LABELER_SCHEMA_STATEMENTS } from '@wispplace/database'
import type postgres from 'postgres'
import type { SignedLabel } from './labels'

/** A label with its place in the labeler's log. Sequence numbers only grow; gaps are allowed. */
export type StoredLabel = SignedLabel & { seq: number }

export interface LabelStore {
	/** Append one signed label to the log, with a moderator note that is never published. */
	append(label: SignedLabel, note: string): Promise<StoredLabel>
	/** Log entries after `cursor`, oldest first: the backfill for subscribeLabels. */
	after(cursor: number, limit: number): Promise<StoredLabel[]>
	latestSeq(): Promise<number>
	/**
	 * The newest label per (uri, cid, val) whose uri matches a pattern, negations included,
	 * with seq after `cursor`, oldest first. A pattern ending in `*` matches by prefix.
	 */
	current(patterns: readonly string[], cursor: number, limit: number): Promise<StoredLabel[]>
}

type LabelRow = {
	seq: string | number
	src: string
	uri: string
	cid: string | null
	val: string
	neg: boolean
	cts: string
	exp: string | null
	sig: Uint8Array
}

function fromRow(row: LabelRow): StoredLabel {
	return {
		seq: Number(row.seq),
		ver: 1,
		src: row.src,
		uri: row.uri,
		...(row.cid ? { cid: row.cid } : {}),
		val: row.val,
		...(row.neg ? { neg: true as const } : {}),
		cts: row.cts,
		...(row.exp ? { exp: row.exp } : {}),
		sig: new Uint8Array(row.sig),
	}
}

/** Split uriPatterns into exact URIs and LIKE prefixes, escaping LIKE's own wildcards. */
export function splitPatterns(patterns: readonly string[]): { exact: string[]; prefixes: string[] } {
	const exact: string[] = []
	const prefixes: string[] = []
	for (const pattern of patterns) {
		if (pattern.endsWith('*')) prefixes.push(`${pattern.slice(0, -1).replace(/[\\%_]/g, '\\$&')}%`)
		else exact.push(pattern)
	}
	return { exact, prefixes }
}

export async function migrateLabelStore(sql: postgres.Sql): Promise<void> {
	for (const statement of LABELER_SCHEMA_STATEMENTS) await sql.unsafe(statement)
}

export function createPostgresLabelStore(sql: postgres.Sql, src: string): LabelStore {
	return {
		async append(label, note) {
			const [row] = await sql<LabelRow[]>`
				INSERT INTO labeler_labels (src, uri, cid, val, neg, cts, exp, sig, note)
				VALUES (${label.src}, ${label.uri}, ${label.cid ?? null}, ${label.val}, ${label.neg === true},
					${label.cts}, ${label.exp ?? null}, ${label.sig}, ${note})
				RETURNING seq, src, uri, cid, val, neg, cts, exp, sig
			`
			if (!row) throw new Error('label insert returned no row')
			return fromRow(row)
		},

		async after(cursor, limit) {
			const rows = await sql<LabelRow[]>`
				SELECT seq, src, uri, cid, val, neg, cts, exp, sig FROM labeler_labels
				WHERE src = ${src} AND seq > ${cursor} ORDER BY seq LIMIT ${limit}
			`
			return rows.map(fromRow)
		},

		async latestSeq() {
			const [row] = await sql<{ seq: string | null }[]>`SELECT max(seq) AS seq FROM labeler_labels`
			return Number(row?.seq ?? 0)
		},

		async current(patterns, cursor, limit) {
			const { exact, prefixes } = splitPatterns(patterns)
			const rows = await sql<LabelRow[]>`
				SELECT * FROM (
					SELECT DISTINCT ON (uri, coalesce(cid, ''), val) seq, src, uri, cid, val, neg, cts, exp, sig
					FROM labeler_labels
					WHERE src = ${src} AND (uri = ANY(${exact}) OR uri LIKE ANY(${prefixes}))
					ORDER BY uri, coalesce(cid, ''), val, seq DESC
				) latest
				WHERE seq > ${cursor} ORDER BY seq LIMIT ${limit}
			`
			return rows.map(fromRow)
		},
	}
}

/** The same contract in memory, for tests and local runs without postgres. */
export function createMemoryLabelStore(): LabelStore & { notes: Map<number, string> } {
	const log: StoredLabel[] = []
	const notes = new Map<number, string>()
	const matches = (uri: string, patterns: readonly string[]) =>
		patterns.some((p) => (p.endsWith('*') ? uri.startsWith(p.slice(0, -1)) : uri === p))
	return {
		notes,
		async append(label, note) {
			const stored = { ...label, seq: log.length + 1 }
			log.push(stored)
			notes.set(stored.seq, note)
			return stored
		},
		async after(cursor, limit) {
			return log.filter((l) => l.seq > cursor).slice(0, limit)
		},
		async latestSeq() {
			return log.length
		},
		async current(patterns, cursor, limit) {
			const latest = new Map<string, StoredLabel>()
			for (const label of log) {
				if (matches(label.uri, patterns)) latest.set(`${label.uri}\u0000${label.cid ?? ''}\u0000${label.val}`, label)
			}
			return [...latest.values()]
				.filter((l) => l.seq > cursor)
				.sort((a, b) => a.seq - b.seq)
				.slice(0, limit)
		},
	}
}
