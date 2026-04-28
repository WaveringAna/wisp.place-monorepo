import type { WebhookEntry } from './db'

export type EventKind = 'create' | 'update' | 'delete'

interface ParsedAtUri {
	did: string
	collection?: string
	rkey?: string
}

/*Compiled regexes keyed by glob pattern*/
const globCache = new Map<string, RegExp>()

/**Parsed AT-URIs keyed by the raw aturi string*/
const atUriCache = new Map<string, ParsedAtUri | null>()

function parseAtUri(aturi: string): ParsedAtUri | null {
	const cached = atUriCache.get(aturi)
	if (cached !== undefined) return cached

	const withoutScheme = aturi.replace(/^at:\/\//, '')
	const parts = withoutScheme.split('/')
	const did = parts[0]
	const result = did ? { did, collection: parts[1] || undefined, rkey: parts[2] || undefined } : null
	atUriCache.set(aturi, result)
	return result
}

function compileGlob(pattern: string): RegExp {
	let re = globCache.get(pattern)
	if (!re) {
		const escaped = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
		re = new RegExp(`^${escaped.join('.*')}$`)
		globCache.set(pattern, re)
	}
	return re
}

function matchesGlob(pattern: string, value: string): boolean {
	if (!pattern.includes('*')) return pattern === value
	return compileGlob(pattern).test(value)
}

/**
 * Recursively walk a parsed record object checking whether any string value
 * starts with `prefix` and has a collection segment matching `collectionRe`,
 * and optionally an rkey segment matching `rkey`.
 */
function walkForReference(
	obj: unknown,
	prefix: string,
	collectionRe: RegExp | null,
	exact: string | null,
	rkey: string | undefined,
): boolean {
	if (typeof obj === 'string') {
		const idx = obj.indexOf(prefix)
		if (idx === -1) return false
		const rest = obj.slice(idx + prefix.length)
		if (collectionRe === null && exact === null) return true // at://did — any reference
		const slashIdx = rest.search(/[/"\\]/)
		const col = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
		if (!col) return false
		const colMatches = exact !== null ? col === exact : collectionRe!.test(col)
		if (!colMatches) return false
		if (!rkey) return true
		if (slashIdx === -1) return false
		const afterSlash = rest.slice(slashIdx + 1)
		const rkeyEnd = afterSlash.search(/[/"\\]/)
		const rkeySegment = rkeyEnd === -1 ? afterSlash : afterSlash.slice(0, rkeyEnd)
		return rkeySegment === rkey
	}
	if (Array.isArray(obj)) {
		for (const v of obj) {
			if (walkForReference(v, prefix, collectionRe, exact, rkey)) return true
		}
		return false
	}
	if (obj !== null && typeof obj === 'object') {
		for (const v of Object.values(obj)) {
			if (walkForReference(v, prefix, collectionRe, exact, rkey)) return true
		}
	}
	return false
}

/**
 * Checks whether a record contains a reference to the given DID/collection/rkey.
 * Uses a recursive walk and pre-compiled regex — no JSON.stringify.
 */
function containsReference(record: unknown, did: string, collection?: string, rkey?: string): boolean {
	const prefix = `at://${did}/`

	if (!collection) {
		return walkForReference(record, `at://${did}`, null, null, undefined)
	}

	const collectionRe = collection.includes('*') ? compileGlob(collection) : null
	const exact = collectionRe ? null : collection
	return walkForReference(record, prefix, collectionRe, exact, rkey)
}

/**
 * Filters a set of webhook candidates against a firehose event.
 *
 * A webhook matches if:
 * - It is enabled
 * - The event kind is in its `events` filter (or no filter is set)
 * - **Direct match**: the event DID/collection/rkey falls within the webhook's scope AT-URI
 *   (collection supports glob patterns, e.g. `app.bsky.*`)
 * - **Backlink match**: `scope.backlinks` is true and the record body contains
 *   a reference to the scope DID/collection
 */
export function matchWebhooks(
	webhooks: WebhookEntry[],
	eventDid: string,
	eventCollection: string,
	eventRkey: string,
	eventKind: EventKind,
	eventRecord: unknown,
): WebhookEntry[] {
	const matched: WebhookEntry[] = []

	for (const entry of webhooks) {
		const { record } = entry

		if (record.enabled === false) continue

		if (record.events && record.events.length > 0) {
			if (!record.events.includes(eventKind)) continue
		}

		const scope = parseAtUri(record.scope.aturi)
		if (!scope) continue

		const backlinks = record.scope.backlinks === true

		let directMatch = false
		if (scope.did === eventDid) {
			if (!scope.collection) {
				directMatch = true
			} else if (matchesGlob(scope.collection, eventCollection)) {
				if (!scope.rkey || scope.rkey === eventRkey) {
					directMatch = true
				}
			}
		}

		if (directMatch) {
			matched.push(entry)
			continue
		}

		if (backlinks && eventRecord != null) {
			if (containsReference(eventRecord, scope.did, scope.collection, scope.rkey)) {
				matched.push(entry)
			}
		}
	}

	return matched
}
