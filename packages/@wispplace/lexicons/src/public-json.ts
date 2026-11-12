import { jsonToLex } from '@atproto/lexicon'

/**
 * Convert the JSON representation returned by AT Protocol XRPC endpoints
 * into the in-memory representation expected by these generated validators.
 */
export function parseLexiconJson<T>(value: unknown): T {
	return jsonToLex(value as Parameters<typeof jsonToLex>[0]) as T
}

const TREE_NODE_KINDS = new Set(['file', 'directory', 'subfs'])
// A record is bounded by the PDS record size limit; this only stops a hostile shape from looping.
const MAX_TREE_DIRECTORIES = 100_000

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse a place.wisp.fs or place.wisp.subfs record.
 *
 * An entry's `node` is a lexicon union, and the validator accepts a union
 * member only when it carries `$type`. Some third-party tools write nodes
 * with just the `type` field. Where `$type` is absent and `type` names one of
 * the node kinds, fill it in: `type` already says the same thing. A node with
 * an unknown `type`, or with a `$type` of its own, is left as it is and still
 * has to pass validation.
 */
export function parseWispTreeJson<T>(value: unknown, collection: 'place.wisp.fs' | 'place.wisp.subfs'): T {
	const record = parseLexiconJson<T>(value)
	const pending: unknown[] = [isPlainObject(record) ? record.root : undefined]
	for (let visited = 0; pending.length > 0 && visited < MAX_TREE_DIRECTORIES; visited++) {
		const directory = pending.pop()
		if (!isPlainObject(directory) || !Array.isArray(directory.entries)) continue
		for (const entry of directory.entries) {
			const node = isPlainObject(entry) ? entry.node : undefined
			if (!isPlainObject(node)) continue
			if (node.$type === undefined && typeof node.type === 'string' && TREE_NODE_KINDS.has(node.type)) {
				node.$type = `${collection}#${node.type}`
			}
			if (node.type === 'directory') pending.push(node)
		}
	}
	return record
}
