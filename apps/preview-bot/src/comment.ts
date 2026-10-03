export interface PreviewRow {
	sha7: string
	url: string
}

/** Older rows fall off so a long-lived pull request keeps a short comment. */
export const MAX_PREVIEW_ROWS = 10

const HEADER = ['**Preview deploys**', '', '| commit | preview |', '| --- | --- |']
const ROW = /^\| `([0-9a-f]{7})` \| \[(https:\/\/[^\]\s]+)\]\((https:\/\/[^)\s]+)\) \|$/

const previewUrl = (sha7: string, host?: string) =>
	new RegExp(`^https://pr-${sha7}-[a-z0-9]+(-[a-z0-9]+)*\\.${host ? host.replaceAll('.', '\\.') : '[a-z0-9.-]+'}/$`)

/** One comment per pull request, newest preview first. */
export function renderComment(rows: readonly PreviewRow[]): string {
	const lines = rows.slice(0, MAX_PREVIEW_ROWS).map(({ sha7, url }) => `| \`${sha7}\` | [${url}](${url}) |`)
	return [...HEADER, ...lines, ''].join('\n')
}

/**
 * The rows an earlier render wrote. The comment is user-visible and editable, so a line only counts
 * when it has exactly the shape we write and a link that is a preview URL for its own commit;
 * anything else is dropped, which keeps edited text from being carried into the next update.
 */
export function parsePreviewRows(body: string, previewHost?: string): PreviewRow[] {
	return body.split('\n').flatMap((line) => {
		const match = ROW.exec(line)
		const [, sha7, label, target] = match ?? []
		if (!sha7 || !label || label !== target || !previewUrl(sha7, previewHost).test(label)) return []
		return [{ sha7, url: label }]
	})
}
