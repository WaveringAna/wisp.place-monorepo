import {
	isCanonicalWebhookDid,
	parseWebhookScopeAtUri,
	validateWebhookRecord as validateSharedWebhookRecord,
} from '@wispplace/atproto-utils'
import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import type { WebhookEntry } from './db'

export type EventKind = 'create' | 'update' | 'delete'

export interface ParsedAtUri {
	readonly aturi: string
	readonly did: string
	readonly collection?: string
	readonly rkey?: string
}

export interface TraversalLimits {
	readonly maxDepth: number
	readonly maxNodes: number
	readonly maxBytes: number
	readonly maxPropertiesPerObject: number
	readonly maxReferences: number
}

export interface BoundedReferenceCollection {
	readonly references: readonly string[]
	/** True when traversal or the relevant-reference cap prevented a complete answer. */
	readonly tooComplex: boolean
}

const DEFAULT_TRAVERSAL_LIMITS: TraversalLimits = Object.freeze({
	maxDepth: 32,
	maxNodes: 2_048,
	maxBytes: 256 * 1_024,
	maxPropertiesPerObject: 256,
	maxReferences: 256,
})

const MAX_CACHE_ENTRIES = 1_024
const COLLECTION_RE = /^[A-Za-z0-9.*-]{1,253}$/
const RKEY_RE = /^[A-Za-z0-9._~:%@+-]{1,512}$/

const globCache = new Map<string, RegExp>()
const atUriCache = new Map<string, ParsedAtUri | null>()

function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, max = MAX_CACHE_ENTRIES): void {
	if (map.has(key)) map.delete(key)
	map.set(key, value)
	if (map.size > max) {
		const oldest = map.keys().next().value
		if (oldest !== undefined) map.delete(oldest)
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	try {
		const prototype = Object.getPrototypeOf(value)
		return prototype === Object.prototype || prototype === null
	} catch {
		return false
	}
}

export function isDid(value: string): boolean {
	return isCanonicalWebhookDid(value)
}

/** Shared canonical DID-only scope parser with a bounded local result cache. */
export function parseAtUri(aturi: string): ParsedAtUri | null {
	if (aturi.length === 0 || aturi.length > 2_048) return null
	if (atUriCache.has(aturi)) return atUriCache.get(aturi) ?? null
	const parsed = parseWebhookScopeAtUri(aturi)
	const result = parsed ? Object.freeze({ ...parsed }) : null
	boundedSet(atUriCache, aturi, result)
	return result
}

export function scopeDid(aturi: string): string | undefined {
	return parseAtUri(aturi)?.did
}

function compileGlob(pattern: string): RegExp {
	const cached = globCache.get(pattern)
	if (cached) {
		// Touch the entry to retain a real LRU bound.
		globCache.delete(pattern)
		globCache.set(pattern, cached)
		return cached
	}
	// Patterns are validated when a webhook is accepted. Escape everything except '*'.
	const escaped = pattern.split('*').map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
	const compiled = new RegExp(`^${escaped.join('.*')}$`)
	boundedSet(globCache, pattern, compiled)
	return compiled
}

function matchesGlob(pattern: string, value: string): boolean {
	if (!pattern.includes('*')) return pattern === value
	return compileGlob(pattern).test(value)
}

function safeEnumerableDataValues(value: object, maxProperties: number): { values: unknown[]; truncated: boolean } {
	let keys: string[]
	try {
		keys = Object.keys(value)
	} catch {
		return { values: [], truncated: true }
	}
	const values: unknown[] = []
	for (const key of keys.slice(0, maxProperties)) {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			// Never invoke accessors from untrusted records.
			if (descriptor?.enumerable && 'value' in descriptor) values.push(descriptor.value)
		} catch {
			// A hostile Proxy must not turn matching into a process crash.
			return { values, truncated: true }
		}
	}
	return { values, truncated: keys.length > maxProperties }
}

function boundedStringWalk(value: unknown, visit: (text: string) => boolean, limits: TraversalLimits): boolean {
	const seen = new WeakSet<object>()
	const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
	let nodes = 0
	let bytes = 0

	while (pending.length > 0) {
		if (nodes >= limits.maxNodes || bytes >= limits.maxBytes) return false
		const current = pending.pop()
		if (!current) break
		nodes++

		if (typeof current.value === 'string') {
			const remaining = limits.maxBytes - bytes
			const valueBytes = Buffer.byteLength(current.value)
			if (valueBytes > remaining) return false
			bytes += valueBytes
			if (visit(current.value)) return true
			continue
		}

		if (current.value === null || typeof current.value !== 'object') continue
		if (current.depth >= limits.maxDepth) return false
		if (!Array.isArray(current.value) && !isPlainObject(current.value)) continue
		if (seen.has(current.value)) continue
		seen.add(current.value)

		const children = safeEnumerableDataValues(current.value, limits.maxPropertiesPerObject)
		if (children.truncated) return false
		for (let index = children.values.length - 1; index >= 0; index--) {
			pending.push({ value: children.values[index], depth: current.depth + 1 })
		}
	}
	return true
}

function referencesInString(text: string, visit: (aturi: string) => boolean): boolean {
	// Backlinks intentionally use only values that are themselves AT-URIs. This
	// avoids interpreting arbitrary prose as a link. Sentence punctuation is not
	// part of a reference value; trim it before parsing rather than extending an
	// rkey with `.` or `)` from surrounding prose.
	let candidate = text.trim()
	while (candidate.length > 0 && /[),;!?\]}'".]/.test(candidate[candidate.length - 1] ?? '')) {
		candidate = candidate.slice(0, -1)
	}
	return parseAtUri(candidate) ? visit(candidate) : false
}

/**
 * Collect relevant AT-URI values without first retaining irrelevant links. This
 * lets callers cap only links that could affect their subscriptions.
 */
export function collectRelevantAtUriReferences(
	value: unknown,
	isRelevant: (aturi: string) => boolean,
	maximum: number,
	partial?: Partial<TraversalLimits>,
): BoundedReferenceCollection {
	const limits: TraversalLimits = { ...DEFAULT_TRAVERSAL_LIMITS, ...partial, maxReferences: maximum }
	const references = new Set<string>()
	let overflow = false
	const complete = boundedStringWalk(
		value,
		(text) =>
			referencesInString(text, (aturi) => {
				if (!isRelevant(aturi) || references.has(aturi)) return false
				if (references.size >= maximum) {
					overflow = true
					return true
				}
				references.add(aturi)
				return false
			}),
		limits,
	)
	return { references: [...references], tooComplex: overflow || !complete }
}

/** Return a bounded, prototype-safe snapshot of all AT-URI reference values. */
export function collectAtUriReferences(value: unknown, partial?: Partial<TraversalLimits>): string[] {
	const maximum = partial?.maxReferences ?? DEFAULT_TRAVERSAL_LIMITS.maxReferences
	return collectRelevantAtUriReferences(value, () => true, maximum, partial).references.slice()
}

/** Return a bounded set of DID targets referenced in a record. */
export function collectReferencedDids(value: unknown, partial?: Partial<TraversalLimits>): Set<string> {
	const result = new Set<string>()
	for (const aturi of collectAtUriReferences(value, partial)) {
		const parsed = parseAtUri(aturi)
		if (parsed) result.add(parsed.did)
	}
	return result
}

/**
 * Strictly validate and copy a webhook record before it is put in the local DB.
 * Copying only known lexicon fields also removes hostile prototypes/accessors.
 */
export function validateWebhookRecord(value: unknown): WhRecord | null {
	const result = validateSharedWebhookRecord(value)
	return result.ok ? result.record : null
}

function containsReference(record: unknown, did: string, collection?: string, rkey?: string): boolean {
	if (!isDid(did)) return false
	for (const aturi of collectAtUriReferences(record)) {
		const reference = parseAtUri(aturi)
		if (!reference || reference.did !== did) continue
		if (!collection) return true
		if (!reference.collection || !matchesGlob(collection, reference.collection)) continue
		if (!rkey || reference.rkey === rkey) return true
	}
	return false
}

/**
 * Filters webhook candidates against a firehose event. `backlinkRecord` lets delete
 * events use a bounded prior-reference snapshot while keeping the payload record absent.
 */
export function matchWebhooks(
	webhooks: readonly WebhookEntry[],
	eventDid: string,
	eventCollection: string,
	eventRkey: string,
	eventKind: EventKind,
	eventRecord: unknown,
	backlinkRecord: unknown = eventRecord,
): WebhookEntry[] {
	if (!isDid(eventDid) || !COLLECTION_RE.test(eventCollection) || !RKEY_RE.test(eventRkey)) return []
	const matched: WebhookEntry[] = []

	for (const entry of webhooks) {
		const record = validateWebhookRecord(entry.record)
		if (!record || record.enabled === false) continue
		if (record.events && record.events.length > 0 && !record.events.includes(eventKind)) continue

		const scope = parseAtUri(record.scope.aturi)
		if (!scope) continue
		const directMatch =
			scope.did === eventDid &&
			(!scope.collection ||
				(matchesGlob(scope.collection, eventCollection) && (!scope.rkey || scope.rkey === eventRkey)))
		if (directMatch) {
			matched.push({ ...entry, record })
			continue
		}

		if (
			record.scope.backlinks === true &&
			backlinkRecord != null &&
			containsReference(backlinkRecord, scope.did, scope.collection, scope.rkey)
		) {
			matched.push({ ...entry, record })
		}
	}
	return matched
}

/** Test-only cache reset. It is intentionally harmless in production. */
export function clearMatcherCaches(): void {
	globCache.clear()
	atUriCache.clear()
}
