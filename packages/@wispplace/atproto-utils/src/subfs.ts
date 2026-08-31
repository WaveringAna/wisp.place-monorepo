import { parseLexiconJson } from '@wispplace/lexicons/public-json'
import type { Directory as FsDirectory, Entry as FsEntry } from '@wispplace/lexicons/types/place/wisp/fs'
import type { Entry as NestedEntry, Record as SubfsRecord } from '@wispplace/lexicons/types/place/wisp/subfs'
import { validateRecord as validateSubfsRecord } from '@wispplace/lexicons/types/place/wisp/subfs'

type FsDirectoryNode = Extract<FsEntry['node'], { type: 'directory' }>
type FsFileNode = Extract<FsEntry['node'], { type: 'file' }>
type FsSubfsNode = Extract<FsEntry['node'], { type: 'subfs' }>
type NestedDirectoryNode = Extract<NestedEntry['node'], { type: 'directory' }>
type NestedFileNode = Extract<NestedEntry['node'], { type: 'file' }>
type NestedSubfsNode = Extract<NestedEntry['node'], { type: 'subfs' }>

/** Structural byte budget accepted by SubFS callers without a package cycle. */
export interface SubfsByteBudget {
	consume(bytes: number): void
}

export interface SubfsFetchOptions {
	signal?: AbortSignal
	byteBudget?: SubfsByteBudget
}

const DID_PATTERN = 'did:[a-z]+:(?:[a-zA-Z0-9._:-]|%[0-9A-F]{2})*[a-zA-Z0-9._-]'
const RECORD_KEY_PATTERN = '[a-zA-Z0-9_~.:-]{1,512}'
const SUBFS_SUBJECT_PATTERN = new RegExp(
	`^at://(?<repo>${DID_PATTERN})/(?<collection>place\\.wisp\\.subfs)/(?<rkey>${RECORD_KEY_PATTERN})$`,
)

/** A canonical record subject that is safe to send to `com.atproto.repo.getRecord`. */
export interface SubfsSubject {
	/** The exact canonical `at://` subject. */
	uri: string
	/** The DID repository that owns the referenced record. */
	repo: string
	collection: 'place.wisp.subfs'
	rkey: string
}

/**
 * Rejects anything other than a canonical, DID-based `place.wisp.subfs` record
 * URI. Handles, queries, fragments, percent-encoded record keys, extra path
 * components, and non-record subjects are deliberately not accepted.
 */
export function parseSubfsSubject(subject: string): SubfsSubject {
	const match = SUBFS_SUBJECT_PATTERN.exec(subject)
	const repo = match?.groups?.repo
	const collection = match?.groups?.collection
	const rkey = match?.groups?.rkey

	if (!repo || collection !== 'place.wisp.subfs' || !rkey || rkey === '.' || rkey === '..' || repo.length > 2048) {
		throw new SubfsExpansionError('INVALID_SUBJECT')
	}

	return {
		uri: subject,
		repo,
		collection: 'place.wisp.subfs',
		rkey,
	}
}

export type SubfsExpansionErrorCode =
	| 'CYCLE'
	| 'DUPLICATE_PATH'
	| 'FETCH_FAILED'
	| 'INVALID_LIMITS'
	| 'INVALID_RECORD'
	| 'INVALID_SUBJECT'
	| 'MAX_DEPTH'
	| 'MAX_ENTRIES'
	| 'MAX_FILES'
	| 'MAX_RECORDS'
	| 'MAX_RAW_BYTES'
	| 'MISSING_RECORD'

const ERROR_MESSAGES: Record<SubfsExpansionErrorCode, string> = {
	CYCLE: 'SubFS expansion contains a cycle',
	DUPLICATE_PATH: 'SubFS expansion contains duplicate output paths',
	FETCH_FAILED: 'SubFS record fetch failed',
	INVALID_LIMITS: 'SubFS expansion limits are invalid',
	INVALID_RECORD: 'SubFS record is invalid',
	INVALID_SUBJECT: 'SubFS subject is invalid',
	MAX_DEPTH: 'SubFS expansion exceeded its nesting limit',
	MAX_ENTRIES: 'SubFS expansion exceeded its entry limit',
	MAX_FILES: 'SubFS expansion exceeded its file limit',
	MAX_RECORDS: 'SubFS expansion exceeded its record limit',
	MAX_RAW_BYTES: 'SubFS expansion exceeded its raw JSON byte limit',
	MISSING_RECORD: 'SubFS record is missing',
}

/** A fail-closed error whose message intentionally omits remote URLs and causes. */
export class SubfsExpansionError extends Error {
	constructor(public readonly code: SubfsExpansionErrorCode) {
		super(ERROR_MESSAGES[code])
		this.name = 'SubfsExpansionError'
	}
}

/** Defaults are intentionally finite even for callers that do not provide limits. */
export const DEFAULT_SUBFS_RAW_JSON_BYTES = 8 * 1024 * 1024

export const DEFAULT_SUBFS_EXPANSION_LIMITS = Object.freeze({
	maxConcurrentFetches: 4,
	maxDepth: 10,
	maxEntries: 5_000,
	maxFiles: 1_000,
	maxRecords: 100,
	maxRawJsonBytes: DEFAULT_SUBFS_RAW_JSON_BYTES,
})

export interface SubfsExpansionLimits {
	/** Maximum number of simultaneous `fetchSubfsRecord` calls. */
	maxConcurrentFetches?: number
	/** Maximum number of SubFS references on one branch. */
	maxDepth?: number
	/** Maximum number of output entries, including directory entries. */
	maxEntries?: number
	/** Maximum number of output file entries. */
	maxFiles?: number
	/** Maximum number of distinct SubFS subjects fetched. */
	maxRecords?: number
	/** Aggregate UTF-8 bytes of fetched raw SubFS JSON values. */
	maxRawJsonBytes?: number
	/** Backward-compatible short spelling for the aggregate raw JSON budget. */
	maxRawBytes?: number
}

export type FetchSubfsRecord = (
	subject: SubfsSubject,
	options?: SubfsFetchOptions,
) => Promise<unknown | null | undefined>

export interface ExpandSubfsOptions {
	/** The repository that owns files already present in the root tree. */
	rootOwnerDid: string
	/** Fetch the raw `value` of a `place.wisp.subfs` record for this subject. */
	fetchSubfsRecord: FetchSubfsRecord
	/** Abort in-flight fetches and expansion work when the caller deadline ends. */
	signal?: AbortSignal
	/** Shared transfer budget charged by the underlying fetcher. */
	byteBudget?: SubfsByteBudget
	limits?: SubfsExpansionLimits
}

/** A fully expanded tree plus the repository that owns every final file blob. */
export interface ExpandedSubfs {
	root: FsDirectory
	ownerDidByFilePath: ReadonlyMap<string, string>
}

interface ResolvedSubfsExpansionLimits {
	maxConcurrentFetches: number
	maxDepth: number
	maxEntries: number
	maxFiles: number
	maxRecords: number
	maxRawJsonBytes: number
}

function resolveLimits(limits?: SubfsExpansionLimits): ResolvedSubfsExpansionLimits {
	const resolved = {
		...DEFAULT_SUBFS_EXPANSION_LIMITS,
		...limits,
		maxRawJsonBytes: limits?.maxRawJsonBytes ?? limits?.maxRawBytes ?? DEFAULT_SUBFS_RAW_JSON_BYTES,
	}

	const nonNegativeLimits: Array<keyof Omit<ResolvedSubfsExpansionLimits, 'maxConcurrentFetches' | 'maxRecords'>> = [
		'maxDepth',
		'maxEntries',
		'maxFiles',
	]
	for (const key of nonNegativeLimits) {
		if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 0) {
			throw new SubfsExpansionError('INVALID_LIMITS')
		}
	}
	if (!Number.isSafeInteger(resolved.maxConcurrentFetches) || resolved.maxConcurrentFetches < 1) {
		throw new SubfsExpansionError('INVALID_LIMITS')
	}
	if (!Number.isSafeInteger(resolved.maxRecords) || resolved.maxRecords < 1) {
		throw new SubfsExpansionError('INVALID_LIMITS')
	}
	if (!Number.isSafeInteger(resolved.maxRawJsonBytes) || resolved.maxRawJsonBytes < 1) {
		throw new SubfsExpansionError('INVALID_LIMITS')
	}

	return resolved
}

class FetchLimiter {
	private active = 0
	private readonly waiting: Array<() => void> = []

	constructor(private readonly limit: number) {}

	async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('SubFS expansion aborted')
		if (this.active >= this.limit) {
			await new Promise<void>((resolve, reject) => {
				let settled = false
				const finish = () => {
					if (settled) return
					settled = true
					if (signal) signal.removeEventListener('abort', abort)
					resolve()
				}
				const abort = () => {
					if (settled) return
					settled = true
					const index = this.waiting.indexOf(finish)
					if (index >= 0) this.waiting.splice(index, 1)
					if (signal) signal.removeEventListener('abort', abort)
					reject(signal?.reason instanceof Error ? signal.reason : new Error('SubFS expansion aborted'))
				}
				this.waiting.push(finish)
				if (signal) signal.addEventListener('abort', abort, { once: true })
				if (signal?.aborted) abort()
			})
		} else {
			this.active++
		}

		try {
			return await work()
		} finally {
			const next = this.waiting.shift()
			if (next) {
				next()
			} else {
				this.active--
			}
		}
	}
}

function isFsDirectoryNode(node: FsEntry['node']): node is FsDirectoryNode {
	return typeof node === 'object' && node !== null && 'type' in node && node.type === 'directory' && 'entries' in node
}

function isFsFileNode(node: FsEntry['node']): node is FsFileNode {
	return typeof node === 'object' && node !== null && 'type' in node && node.type === 'file' && 'blob' in node
}

function isFsSubfsNode(node: FsEntry['node']): node is FsSubfsNode {
	return typeof node === 'object' && node !== null && 'type' in node && node.type === 'subfs' && 'subject' in node
}

function isNestedDirectoryNode(node: NestedEntry['node']): node is NestedDirectoryNode {
	return typeof node === 'object' && node !== null && 'type' in node && node.type === 'directory' && 'entries' in node
}

function isNestedFileNode(node: NestedEntry['node']): node is NestedFileNode {
	return typeof node === 'object' && node !== null && 'type' in node && node.type === 'file' && 'blob' in node
}

function isNestedSubfsNode(node: NestedEntry['node']): node is NestedSubfsNode {
	return typeof node === 'object' && node !== null && 'type' in node && node.type === 'subfs' && 'subject' in node
}

function toFsFile(node: NestedFileNode): FsFileNode {
	const file: FsFileNode = {
		$type: 'place.wisp.fs#file',
		type: 'file',
		blob: node.blob,
	}
	if (node.encoding !== undefined) file.encoding = node.encoding
	if (node.mimeType !== undefined) file.mimeType = node.mimeType
	if (node.base64 !== undefined) file.base64 = node.base64
	return file
}

function toFsSubfs(node: NestedSubfsNode): FsSubfsNode {
	return {
		$type: 'place.wisp.fs#subfs',
		type: 'subfs',
		subject: node.subject,
	}
}

function toFsDirectory(node: NestedDirectoryNode): FsDirectoryNode {
	return {
		$type: 'place.wisp.fs#directory',
		type: 'directory',
		entries: node.entries.map(toFsEntry),
	}
}

function toFsNode(node: NestedEntry['node']): FsEntry['node'] {
	if (isNestedFileNode(node)) return toFsFile(node)
	if (isNestedDirectoryNode(node)) return toFsDirectory(node)
	if (isNestedSubfsNode(node)) return toFsSubfs(node)
	return node
}

function toFsEntry(entry: NestedEntry): FsEntry {
	return {
		$type: 'place.wisp.fs#entry',
		name: entry.name,
		node: toFsNode(entry.node),
	}
}

function makeDirectory(entries: FsEntry[]): FsDirectoryNode {
	return {
		$type: 'place.wisp.fs#directory',
		type: 'directory',
		entries,
	}
}

/**
 * Extract all SubFS subjects from a filesystem directory, retaining the mount
 * path used by existing record cleanup callers. This intentionally does not
 * fetch or validate subjects; expansion does both before a network request.
 */
export function extractSubfsUris(directory: FsDirectory, currentPath = ''): Array<{ uri: string; path: string }> {
	const uris: Array<{ uri: string; path: string }> = []

	for (const entry of directory.entries) {
		const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
		if (isFsSubfsNode(entry.node) && typeof entry.node.subject === 'string') {
			uris.push({ uri: entry.node.subject, path: fullPath })
		} else if (isFsDirectoryNode(entry.node)) {
			uris.push(...extractSubfsUris(entry.node, fullPath))
		}
	}

	return uris
}

/**
 * Expands all `place.wisp.subfs` references in a filesystem tree.
 *
 * Every referenced raw record is converted from XRPC JSON and validated before
 * use. Duplicate canonical subjects share one fetch promise. A subject may be
 * used by separate branches, but a subject already on the current branch is a
 * cycle and fails the complete expansion. Final output paths must also be
 * unique, so a flat mount can never silently overwrite an earlier entry.
 *
 * A root `place.wisp.fs#subfs` splices children unless `flat === false`, in
 * which case it becomes a directory named by the mounting entry. Nested
 * `place.wisp.subfs#subfs` nodes have no `flat` field and therefore splice.
 */
export async function expandSubfs(directory: FsDirectory, options: ExpandSubfsOptions): Promise<ExpandedSubfs> {
	const limits = resolveLimits(options.limits)
	const limiter = new FetchLimiter(limits.maxConcurrentFetches)
	const records = new Map<string, Promise<SubfsRecord>>()
	const ownerDidByFilePath = new Map<string, string>()
	const outputPaths = new Set<string>()
	let expandedEntries = 0
	let expandedFiles = 0
	let rawJsonBytes = 0

	const countOutput = (entry: FsEntry, path: string, ownerDid: string) => {
		if (outputPaths.has(path)) throw new SubfsExpansionError('DUPLICATE_PATH')
		outputPaths.add(path)

		expandedEntries++
		if (expandedEntries > limits.maxEntries) throw new SubfsExpansionError('MAX_ENTRIES')
		if (isFsFileNode(entry.node)) {
			expandedFiles++
			if (expandedFiles > limits.maxFiles) throw new SubfsExpansionError('MAX_FILES')
			ownerDidByFilePath.set(path, ownerDid)
		}
	}

	const fetchRecord = (subject: SubfsSubject): Promise<SubfsRecord> => {
		const existing = records.get(subject.uri)
		if (existing) return existing
		if (records.size >= limits.maxRecords) return Promise.reject(new SubfsExpansionError('MAX_RECORDS'))

		const pending = limiter.run(async () => {
			if (options.signal?.aborted) {
				const reason = options.signal.reason
				throw reason instanceof Error ? reason : new SubfsExpansionError('FETCH_FAILED')
			}
			let rawRecord: unknown | null | undefined
			try {
				rawRecord = await options.fetchSubfsRecord(subject, {
					signal: options.signal,
					byteBudget: options.byteBudget,
				})
			} catch (error) {
				if (error instanceof SubfsExpansionError) throw error
				throw new SubfsExpansionError('FETCH_FAILED')
			}
			if (rawRecord === null || rawRecord === undefined) throw new SubfsExpansionError('MISSING_RECORD')

			let serialized: string
			try {
				serialized = JSON.stringify(rawRecord)
			} catch {
				throw new SubfsExpansionError('INVALID_RECORD')
			}
			if (typeof serialized !== 'string') throw new SubfsExpansionError('INVALID_RECORD')
			rawJsonBytes += new TextEncoder().encode(serialized).byteLength
			if (rawJsonBytes > limits.maxRawJsonBytes) throw new SubfsExpansionError('MAX_RAW_BYTES')

			let record: SubfsRecord
			try {
				record = parseLexiconJson<SubfsRecord>(rawRecord)
			} catch {
				throw new SubfsExpansionError('INVALID_RECORD')
			}
			if (!validateSubfsRecord(record).success) throw new SubfsExpansionError('INVALID_RECORD')
			return record
		}, options.signal)
		records.set(subject.uri, pending)
		return pending
	}

	const expandEntries = async (
		entries: FsEntry[],
		depth: number,
		branch: ReadonlySet<string>,
		pathPrefix: string,
		ownerDid: string,
	): Promise<FsEntry[]> => {
		const expanded: FsEntry[][] = []
		// Promise microtasks alone can starve timers when a hostile tree has many
		// entries. Yield between small batches using a real macrotask.
		for (let index = 0; index < entries.length; index += 32) {
			if (options.signal?.aborted) {
				const reason = options.signal.reason
				throw reason instanceof Error ? reason : new SubfsExpansionError('FETCH_FAILED')
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 0))
			const batch = entries.slice(index, index + 32)
			expanded.push(
				(await Promise.all(batch.map((entry) => expandEntry(entry, depth, branch, pathPrefix, ownerDid)))).flat(),
			)
		}
		return expanded.flat()
	}

	const expandEntry = async (
		entry: FsEntry,
		depth: number,
		branch: ReadonlySet<string>,
		pathPrefix: string,
		ownerDid: string,
	): Promise<FsEntry[]> => {
		if (options.signal?.aborted) {
			const reason = options.signal.reason
			throw reason instanceof Error ? reason : new SubfsExpansionError('FETCH_FAILED')
		}
		const path = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name
		if (isFsSubfsNode(entry.node)) {
			if (typeof entry.node.subject !== 'string') throw new SubfsExpansionError('INVALID_SUBJECT')
			if (depth >= limits.maxDepth) throw new SubfsExpansionError('MAX_DEPTH')

			const subject = parseSubfsSubject(entry.node.subject)
			if (branch.has(subject.uri)) throw new SubfsExpansionError('CYCLE')
			const record = await fetchRecord(subject)
			const nextBranch = new Set(branch)
			nextBranch.add(subject.uri)
			const nestedEntries = record.root.entries.map(toFsEntry)
			const replacementPrefix = entry.node.flat === false ? path : pathPrefix
			const replacement = await expandEntries(nestedEntries, depth + 1, nextBranch, replacementPrefix, subject.repo)

			if (entry.node.flat === false) {
				const mounted: FsEntry = { ...entry, node: makeDirectory(replacement) }
				countOutput(mounted, path, ownerDid)
				return [mounted]
			}
			return replacement
		}

		if (isFsDirectoryNode(entry.node)) {
			const children = await expandEntries(entry.node.entries, depth, branch, path, ownerDid)
			const expandedEntry: FsEntry = {
				...entry,
				node: {
					...entry.node,
					entries: children,
				},
			}
			countOutput(expandedEntry, path, ownerDid)
			return [expandedEntry]
		}

		countOutput(entry, path, ownerDid)
		return [entry]
	}

	return {
		root: {
			...directory,
			entries: await expandEntries(directory.entries, 0, new Set(), '', options.rootOwnerDid),
		},
		ownerDidByFilePath,
	}
}

/**
 * Compatibility form for callers that only need the expanded directory. New
 * callers should use {@link expandSubfs} so cross-repository blob ownership is
 * retained.
 */
export async function expandSubfsNodes(directory: FsDirectory, options: ExpandSubfsOptions): Promise<FsDirectory> {
	return (await expandSubfs(directory, options)).root
}
