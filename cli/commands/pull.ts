import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import {
	expandSubfs,
	extractBlobCid,
	getPdsForDid,
	readBoundedIdentityJson,
	resolveDid,
	type SubfsSubject,
	unsafeRawIdentityGet,
} from '@wispplace/atproto-utils'
import { MAX_BLOB_SIZE, MAX_FILE_COUNT, MAX_SITE_SIZE_SUPPORTER } from '@wispplace/constants'
import { normalizeSitePath } from '@wispplace/fs-utils'
import { parseLexiconJson } from '@wispplace/lexicons/public-json'
import type { Entry, Record as FsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { validateRecord as validateFsRecord } from '@wispplace/lexicons/types/place/wisp/fs'
import { loadMetadata, type SiteMetadata, saveMetadata } from '../lib/metadata.ts'
import { createSpinner, pc } from '../lib/progress.ts'

// full blobs remain resident through base64/gzip decoding and the atomic write
const MAX_CONCURRENT_DOWNLOADS = 3
export const MAX_PDS_RECORD_RESPONSE_BYTES = 1024 * 1024
export const PDS_RECORD_TIMEOUT_MS = 10_000
export const PDS_BLOB_TIMEOUT_MS = 300_000
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const gunzipAsync = promisify(gunzip)

/** Decompress one pulled site blob without accepting unbounded gzip output. */
export async function decompressPulledGzip(content: Uint8Array, maxOutputBytes = MAX_BLOB_SIZE): Promise<Buffer> {
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > MAX_BLOB_SIZE) {
		throw new RangeError('Pulled gzip output limit must be within the blob limit')
	}
	try {
		return await gunzipAsync(content, { maxOutputLength: maxOutputBytes })
	} catch {
		throw new Error('Could not safely decompress gzip blob')
	}
}

/** Buffer a remote site blob only until the shared per-file byte limit. */
export async function readPulledBlob(response: Response, maxBytes = MAX_BLOB_SIZE): Promise<Buffer> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BLOB_SIZE) {
		throw new RangeError('Pulled blob limit must be within the blob limit')
	}
	const reader = response.body?.getReader()
	if (!reader) return Buffer.alloc(0)

	const chunks: Uint8Array[] = []
	let totalBytes = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			totalBytes += value.byteLength
			if (totalBytes > maxBytes) throw new Error(`Downloaded blob exceeds the ${maxBytes}-byte limit`)
			chunks.push(value)
		}
	} catch (error) {
		await reader.cancel(error).catch(() => undefined)
		throw error
	} finally {
		reader.releaseLock()
	}
	return Buffer.concat(chunks, totalBytes)
}

export function validatePulledGzipHeader(content: Uint8Array): void {
	if (content.length < 2 || content[0] !== 0x1f || content[1] !== 0x8b) {
		throw new Error('Blob is marked gzip but is not a gzip stream')
	}
}

export function createLogicalSiteBudget(maxBytes = MAX_SITE_SIZE_SUPPORTER) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_SITE_SIZE_SUPPORTER) {
		throw new RangeError('Logical site size limit is invalid')
	}
	let totalSize = 0
	return {
		reserve(bytes: number) {
			if (!Number.isSafeInteger(bytes) || bytes < 0 || totalSize > maxBytes - bytes) {
				throw new Error(`Pulled site exceeds the ${maxBytes}-byte logical size limit`)
			}
			totalSize += bytes
		},
		get totalSize() {
			return totalSize
		},
	}
}

function requireSiteFilePath(path: string): string {
	const normalized = normalizeSitePath(path)
	if (
		!normalized ||
		normalized !== path ||
		normalized
			.split('/')
			.some((segment) => segment.includes(':') || /[. ]$/.test(segment) || WINDOWS_RESERVED_NAME.test(segment))
	) {
		throw new Error('Site contains an invalid file path')
	}
	return normalized
}

function isWithinRoot(root: string, target: string): boolean {
	const fromRoot = relative(root, target)
	return fromRoot !== '' && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(path)
	} catch {
		return null
	}
}

/** Resolve a validated site path without following untrusted child symlinks. */
export function resolvePullFilePath(root: string, sitePath: string, createParents = false): string {
	const relativePath = requireSiteFilePath(sitePath)
	const rootInfo = lstatSync(root)
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
		throw new Error('Pull root must be a directory, not a symbolic link')
	}

	const rootPath = realpathSync(root)
	const parts = relativePath.split('/')
	let directory = rootPath
	for (const segment of parts.slice(0, -1)) {
		directory = join(directory, segment)
		let info = lstatOrNull(directory)
		if (!info) {
			if (!createParents) continue
			mkdirSync(directory)
			info = lstatOrNull(directory)
		}
		if (!info || info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error('Pull path contains an unsafe directory')
		}
	}

	const target = resolve(rootPath, ...parts)
	if (!isWithinRoot(rootPath, target)) {
		throw new Error('Resolved pull path escapes its root')
	}
	if (lstatOrNull(target)?.isSymbolicLink()) {
		throw new Error('Pull path resolves to a symbolic link')
	}
	return target
}

export interface PullOptions {
	site: string
	path: string
}

const SUBFS_EXPANSION_LIMITS = {
	maxConcurrentFetches: 4,
	maxDepth: 10,
	maxEntries: MAX_FILE_COUNT * 4,
	maxFiles: MAX_FILE_COUNT,
	maxRecords: 100,
} as const

interface GetRecordResponse {
	value: unknown
	cid?: string
}

function isGetRecordResponse(value: unknown): value is GetRecordResponse {
	if (typeof value !== 'object' || value === null || !('value' in value)) return false
	return !('cid' in value) || value.cid === undefined || typeof value.cid === 'string'
}

async function fetchRecord(
	pdsEndpoint: string,
	did: string,
	collection: string,
	rkey: string,
): Promise<GetRecordResponse> {
	const query = new URLSearchParams({ repo: did, collection, rkey })
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), PDS_RECORD_TIMEOUT_MS)
	let res: Response
	try {
		res = await fetch(`${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?${query.toString()}`, {
			signal: controller.signal,
		})
		if (!res.ok) {
			await res.body?.cancel().catch(() => undefined)
			throw new Error(`Failed to fetch record: ${res.status}`)
		}
		const data: unknown = await readBoundedIdentityJson(res, MAX_PDS_RECORD_RESPONSE_BYTES, controller.signal)
		if (!isGetRecordResponse(data)) throw new Error('PDS returned an invalid record response')
		return data
	} finally {
		clearTimeout(timeout)
	}
}

type PdsEndpointResolver = (did: string) => Promise<string>

function createPdsEndpointResolver(rootDid: string, rootPdsEndpoint: string): PdsEndpointResolver {
	const endpoints = new Map<string, Promise<string>>([[rootDid, Promise.resolve(rootPdsEndpoint)]])

	return (sourceDid) => {
		const existing = endpoints.get(sourceDid)
		if (existing) return existing

		const pending = (async () => {
			const endpoint = await getPdsForDid(sourceDid, unsafeRawIdentityGet, { allowLoopback: true })
			if (!endpoint) throw new Error('Could not resolve a source PDS endpoint')
			return endpoint
		})()
		endpoints.set(sourceDid, pending)
		return pending
	}
}

async function fetchSubfsRecord(subject: SubfsSubject, resolvePdsEndpoint: PdsEndpointResolver): Promise<unknown> {
	const pdsEndpoint = await resolvePdsEndpoint(subject.repo)
	const response = await fetchRecord(pdsEndpoint, subject.repo, subject.collection, subject.rkey)
	return response.value
}

interface FileToDownload {
	path: string
	cid: string
	ownerDid: string
	encoding?: 'gzip'
	mimeType?: string
	base64?: boolean
}

function collectFiles(
	entries: Entry[],
	ownerDidByFilePath: ReadonlyMap<string, string>,
	pathPrefix: string,
	existingCids: Record<string, string>,
): { toDownload: FileToDownload[]; unchangedFiles: FileToDownload[] } {
	const toDownload: FileToDownload[] = []
	const seenPaths = new Set<string>()
	const unchangedFiles: FileToDownload[] = []

	function entryPath(parent: string, name: string): string {
		const segment = requireSiteFilePath(name)
		if (segment.includes('/')) throw new Error('Site entry names must be single path segments')
		const path = parent ? `${parent}/${segment}` : segment
		if (seenPaths.has(path)) throw new Error('Site contains duplicate file paths')
		seenPaths.add(path)
		return path
	}

	function collect(entries: Entry[], currentPath: string) {
		for (const entry of entries) {
			const fullPath = entryPath(currentPath, entry.name)
			const node = entry.node

			if ('type' in node && node.type === 'directory' && 'entries' in node) {
				collect(node.entries, fullPath)
			} else if ('type' in node && node.type === 'file' && 'blob' in node) {
				const cid = extractBlobCid(node.blob)
				if (!cid) continue

				const ownerDid = ownerDidByFilePath.get(fullPath)
				if (!ownerDid) throw new Error('Expanded file is missing its source repository')
				const file = {
					path: fullPath,
					cid,
					ownerDid,
					encoding: node.encoding,
					mimeType: node.mimeType,
					base64: node.base64,
				} satisfies FileToDownload
				if (existingCids[fullPath] === cid) unchangedFiles.push(file)
				else toDownload.push(file)
			}
		}
	}

	collect(entries, pathPrefix)
	return { toDownload, unchangedFiles }
}

function withDeadline(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), timeoutMs)
	const abort = () => controller.abort(parent?.reason)
	if (parent?.aborted) controller.abort(parent.reason)
	parent?.addEventListener('abort', abort, { once: true })
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timeout)
			parent?.removeEventListener('abort', abort)
		},
	}
}

async function downloadBlob(pdsEndpoint: string, file: FileToDownload, signal?: AbortSignal): Promise<Buffer> {
	const url = `${pdsEndpoint}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(file.ownerDid)}&cid=${encodeURIComponent(file.cid)}`
	const deadline = withDeadline(signal, PDS_BLOB_TIMEOUT_MS)
	try {
		const res = await fetch(url, { signal: deadline.signal })

		if (!res.ok) {
			await res.body?.cancel().catch(() => undefined)
			throw new Error(`Failed to download blob ${file.cid}: ${res.status}`)
		}

		let content: Buffer = await readPulledBlob(res)

		// Decode base64 if needed
		if (file.base64) {
			const base64String = content.toString('utf-8')
			content = Buffer.from(base64String, 'base64')
		}

		// The CLI writes decoded site files, so malformed or oversized gzip must
		// fail the pull rather than becoming an opaque canonical-looking output.
		if (file.encoding === 'gzip') {
			validatePulledGzipHeader(content)
			content = await decompressPulledGzip(content)
		}

		return content
	} finally {
		deadline.dispose()
	}
}

export async function pull(identifier: string, options: PullOptions): Promise<void> {
	const { site, path: outputPath } = options

	console.log(pc.cyan(`\nPulling ${pc.bold(site)} from ${identifier}\n`))

	// 1. Resolve DID
	const spinner = createSpinner('Resolving identity...').start()
	const did = await resolveDid(identifier, unsafeRawIdentityGet)

	if (!did) {
		spinner.fail('Failed to resolve identity')
		throw new Error(`Could not resolve: ${identifier}`)
	}

	spinner.succeed(`Resolved to ${did}`)

	// 2. Get PDS endpoint
	const pdsSpinner = createSpinner('Getting PDS endpoint...').start()
	const pdsEndpoint = await getPdsForDid(did, unsafeRawIdentityGet, { allowLoopback: true })

	if (!pdsEndpoint) {
		pdsSpinner.fail('Failed to get PDS endpoint')
		throw new Error(`Could not get PDS for: ${did}`)
	}

	pdsSpinner.succeed('Got PDS endpoint')
	const resolveSourcePdsEndpoint = createPdsEndpointResolver(did, pdsEndpoint)

	// 3. Fetch and validate the site record
	const recordSpinner = createSpinner('Fetching site record...').start()
	let recordData: GetRecordResponse
	try {
		recordData = await fetchRecord(pdsEndpoint, did, 'place.wisp.fs', site)
	} catch {
		recordSpinner.fail('Site not found')
		throw new Error(`Site not found: ${site}`)
	}

	let record: FsRecord
	try {
		record = parseLexiconJson<FsRecord>(recordData.value)
		if (!validateFsRecord(record).success) throw new Error('Invalid site record')
	} catch {
		recordSpinner.fail('Site record is invalid')
		throw new Error('Site record is invalid')
	}
	const recordCid = recordData.cid || ''
	recordSpinner.succeed('Fetched site record')

	// 4. Expand SubFS nodes. The shared helper validates children, preserves
	// owner DID provenance, and fails closed on partial expansion.
	const expandSpinner = createSpinner('Expanding subfs nodes...').start()
	let expandedRoot: FsRecord['root']
	let ownerDidByFilePath: ReadonlyMap<string, string>
	try {
		const expanded = await expandSubfs(record.root, {
			rootOwnerDid: did,
			fetchSubfsRecord: (subject) => fetchSubfsRecord(subject, resolveSourcePdsEndpoint),
			limits: SUBFS_EXPANSION_LIMITS,
		})
		expandedRoot = expanded.root
		ownerDidByFilePath = expanded.ownerDidByFilePath
	} catch {
		expandSpinner.fail('Could not expand SubFS nodes')
		throw new Error('Could not expand SubFS nodes')
	}
	expandSpinner.succeed('Expanded SubFS nodes')

	// 5. Load existing metadata for incremental updates.
	const existingMetadata = loadMetadata(outputPath)
	const existingCids = existingMetadata?.fileCids || {}
	for (const filePath of Object.keys(existingCids)) {
		requireSiteFilePath(filePath)
	}
	if (existsSync(outputPath)) {
		const outputInfo = lstatSync(outputPath)
		if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory()) {
			throw new Error('Output path must be a directory, not a symbolic link')
		}
	}

	// 6. Collect files to download.
	const collected = collectFiles(expandedRoot.entries, ownerDidByFilePath, '', existingCids)
	const unchangedFiles = collected.unchangedFiles.filter((file) => {
		try {
			return statSync(resolvePullFilePath(outputPath, file.path)).isFile()
		} catch {
			return false
		}
	})
	const toDownload = [
		...collected.toDownload,
		...collected.unchangedFiles.filter((file) => !unchangedFiles.includes(file)),
	]
	const unchangedPaths = unchangedFiles.map((file) => file.path)
	const toSkip = unchangedFiles.length

	console.log(pc.dim(`Files to download: ${toDownload.length}, unchanged: ${toSkip}`))

	const logicalBudget = createLogicalSiteBudget()
	if (toDownload.length === 0 && toSkip > 0) {
		for (const filePath of unchangedPaths) {
			const srcPath = resolvePullFilePath(outputPath, filePath)
			if (existsSync(srcPath)) logicalBudget.reserve(statSync(srcPath).size)
		}
		console.log(pc.green('\n✓ Site is already up to date\n'))
		return
	}

	// 7. Create a non-symlink temp directory.
	mkdirSync(dirname(outputPath), { recursive: true })
	const tempDir = mkdtempSync(`${outputPath}.tmp-`)
	const tempInfo = lstatSync(tempDir)
	if (tempInfo.isSymbolicLink() || !tempInfo.isDirectory()) {
		throw new Error('Temporary pull path must be a directory, not a symbolic link')
	}

	// 8. Download files.
	const downloadSpinner = createSpinner(`Downloading ${toDownload.length} files...`).start()
	const newFileCids: Record<string, string> = Object.fromEntries(
		unchangedFiles.map((file) => [file.path, file.cid]),
	) as Record<string, string>
	let downloaded = 0

	try {
		for (let i = 0; i < toDownload.length; i += MAX_CONCURRENT_DOWNLOADS) {
			const batch = toDownload.slice(i, i + MAX_CONCURRENT_DOWNLOADS)

			const batchController = new AbortController()
			const results = await Promise.allSettled(
				batch.map(async (file) => {
					try {
						const sourcePdsEndpoint = await resolveSourcePdsEndpoint(file.ownerDid)
						const content = await downloadBlob(sourcePdsEndpoint, file, batchController.signal)
						logicalBudget.reserve(content.byteLength)
						const filePath = resolvePullFilePath(tempDir, file.path, true)
						writeFileSync(filePath, content)

						newFileCids[file.path] = file.cid
						downloaded++
						downloadSpinner.text = `Downloading files: ${downloaded}/${toDownload.length}`
					} catch (error) {
						batchController.abort(error)
						throw error
					}
				}),
			)
			const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
			if (failure) throw failure.reason
		}

		downloadSpinner.succeed(`Downloaded ${downloaded} files`)

		// 9. Copy unchanged files from existing directory
		if (toSkip > 0 && existsSync(outputPath)) {
			const copySpinner = createSpinner(`Copying ${toSkip} unchanged files...`).start()

			for (const filePath of unchangedPaths) {
				const srcPath = resolvePullFilePath(outputPath, filePath)
				const destPath = resolvePullFilePath(tempDir, filePath, true)

				if (existsSync(srcPath)) {
					logicalBudget.reserve(statSync(srcPath).size)
					copyFileSync(srcPath, destPath)
				}
			}

			copySpinner.succeed(`Copied ${toSkip} unchanged files`)
		}

		// 10. Atomic replace
		if (existsSync(outputPath)) {
			const backupPath = `${outputPath}.backup-${Date.now()}`
			renameSync(outputPath, backupPath)
			try {
				renameSync(tempDir, outputPath)
			} catch (error) {
				try {
					renameSync(backupPath, outputPath)
				} catch {
					// preserve the original replacement failure; the backup remains recoverable
				}
				throw error
			}
			rmSync(backupPath, { recursive: true, force: true })
		} else {
			renameSync(tempDir, outputPath)
		}

		// 11. Save metadata
		const metadata: SiteMetadata = {
			recordCid,
			fileCids: newFileCids,
			lastSync: Date.now(),
		}
		saveMetadata(outputPath, metadata)

		console.log(pc.green(`\n✓ Pulled ${site} to ${outputPath}\n`))
	} catch (err) {
		// Cleanup temp dir on error
		rmSync(tempDir, { recursive: true, force: true })
		throw err
	}
}
