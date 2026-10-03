import { isCasKey } from './cas-key'

/** `site_cache.file_objects`: manifest path -> CAS key. Null means nothing is mapped. */
export type FileObjects = Record<string, string>

export interface CasReferenceDiff {
	/** Keys this site now references that it did not before: take one reference each. */
	readonly added: ReadonlySet<string>
	/** Keys this site no longer references: release one reference each. */
	readonly removed: ReadonlySet<string>
}

/**
 * Read the jsonb column. Returns null (nothing mapped) unless every value is a well-formed CAS key:
 * a read must never be steered at an arbitrary storage key, and a half-trusted mapping would serve
 * some paths and silently drop others.
 */
export function normalizeFileObjects(value: unknown): FileObjects | null {
	let candidate = value
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate) as unknown
		} catch {
			return null
		}
	}
	if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null

	const entries = Object.entries(candidate)
	for (const [, key] of entries) {
		if (typeof key !== 'string' || !isCasKey(key)) return null
	}
	// fromEntries defines own properties, so a hostile path such as "__proto__" stays data.
	return Object.fromEntries(entries) as FileObjects
}

/** Keys referenced by one site. A site holds one reference per distinct key, however many paths use it. */
export function distinctCasKeys(objects: FileObjects | null): Set<string> {
	return new Set(objects ? Object.values(objects) : [])
}

/** The refcount changes implied by moving one site from `previous` to `next`. */
export function diffCasReferences(previous: FileObjects | null, next: FileObjects | null): CasReferenceDiff {
	const before = distinctCasKeys(previous)
	const after = distinctCasKeys(next)
	return {
		added: new Set([...after].filter((key) => !before.has(key))),
		removed: new Set([...before].filter((key) => !after.has(key))),
	}
}
