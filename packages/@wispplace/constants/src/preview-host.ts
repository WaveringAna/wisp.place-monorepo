/**
 * Preview hostnames carry both the site and its owner's wisp subdomain in one
 * label. Routing and on-demand certificate permission checks share this grammar:
 *
 *   pr-<sha7>-<claim>.<PREVIEW_HOST>
 *
 * `<sha7>` is the head commit of a pull request round and names the site rkey
 * `pr-<sha7>`; the `pr-` prefix keeps this origin from serving production sites.
 * `<claim>` is a wisp subdomain (`<claim>.<BASE_HOST>`) registered by the owner and
 * resolves to the owner's DID. Without it, anyone could write the same rkey into
 * their own repo and answer for someone else's commit. The sha is a fixed width,
 * so the claim may contain hyphens without making the split ambiguous.
 */

export const PREVIEW_RKEY_PREFIX = 'pr-'

export type PreviewSite = {
	readonly rkey: string
	readonly claim: string
}

const MAX_LABEL_LENGTH = 63
const CLAIM = '[a-z0-9]+(?:-[a-z0-9]+)*'
const PREVIEW_LABEL_PATTERN = new RegExp(`^(${PREVIEW_RKEY_PREFIX}[0-9a-f]{7})-(${CLAIM})$`)

/** Parse `pr-<sha7>-<claim>.<previewHost>`; null for the apex, deeper hosts and malformed labels. */
export function parsePreviewHostname(hostname: string, previewHost: string): PreviewSite | null {
	const suffix = `.${previewHost}`
	if (!hostname.endsWith(suffix)) return null

	const label = hostname.slice(0, -suffix.length)
	if (label.length > MAX_LABEL_LENGTH) return null

	const match = PREVIEW_LABEL_PATTERN.exec(label)
	if (!match) return null
	return { rkey: match[1] ?? '', claim: match[2] ?? '' }
}

/** True for the preview apex and any host beneath it, whether or not the label parses. */
export function isPreviewHostname(hostname: string, previewHost: string): boolean {
	return hostname === previewHost || hostname.endsWith(`.${previewHost}`)
}
