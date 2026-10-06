export interface PreviewRow {
	sha7: string
	/** The commit as the link names it: the full sha, or only `sha7` for rows written before commits were linked. */
	sha: string
	url: string
}

/** Older rows fall off so a long-lived pull request keeps a short comment. */
export const MAX_PREVIEW_ROWS = 10

const HEADER = ['**preview deploys**', '', '| commit | preview |', '| --- | --- |']
const ROW =
	/^\| \[`([0-9a-f]{7})`\]\(https:\/\/tangled\.org\/[^)\s]+\/commit\/([0-9a-f]{7,40})\) \| \[open preview\]\((https:\/\/[^)\s]+)\) \|$/
/** Rows from before commits were linked: the url was its own label. */
const LEGACY_ROW = /^\| `([0-9a-f]{7})` \| \[(https:\/\/[^\]\s]+)\]\((https:\/\/[^)\s]+)\) \|$/

const previewUrl = (sha7: string, host?: string) =>
	new RegExp(`^https://pr-${sha7}-[a-z0-9]+(-[a-z0-9]+)*\\.${host ? host.replaceAll('.', '\\.') : '[a-z0-9.-]+'}/$`)

/** Where a commit of the pull request's repo lives on tangled; tangled sends a DID on to the handle. */
export const commitLink = (owner: string, repo: string, sha: string) =>
	`https://tangled.org/${owner}/${repo}/commit/${sha}`

/** One comment per pull request, newest preview first. */
export function renderComment(rows: readonly PreviewRow[], repo: { owner: string; name: string }): string {
	const lines = rows
		.slice(0, MAX_PREVIEW_ROWS)
		.map(
			({ sha7, sha, url }) => `| [\`${sha7}\`](${commitLink(repo.owner, repo.name, sha)}) | [open preview](${url}) |`,
		)
	return [...HEADER, ...lines, ''].join('\n')
}

const parseRow = (line: string): PreviewRow | null => {
	const [, sha7, sha, url] = ROW.exec(line) ?? []
	if (sha7 && sha?.startsWith(sha7) && url) return { sha7, sha, url }
	const [, legacySha7, label, target] = LEGACY_ROW.exec(line) ?? []
	if (legacySha7 && label && label === target) return { sha7: legacySha7, sha: legacySha7, url: label }
	return null
}

/**
 * The rows an earlier render wrote. The comment is user-visible and editable, so a line only counts
 * when it has exactly the shape we write and a link that is a preview URL for its own commit;
 * anything else is dropped, which keeps edited text from being carried into the next update. The
 * commit link is rebuilt from the pull request's repo on render, so only its sha is carried over.
 */
export function parsePreviewRows(body: string, previewHost?: string): PreviewRow[] {
	return body.split('\n').flatMap((line) => {
		const row = parseRow(line)
		return row && previewUrl(row.sha7, previewHost).test(row.url) ? [row] : []
	})
}
