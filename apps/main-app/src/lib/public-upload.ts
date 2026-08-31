import { gzip } from 'node:zlib'
import type { Agent } from '@atproto/api'
import { TID } from '@atproto/common-web'
import {
	computeCID,
	extractBlobMap,
	extractSubfsUris,
	isTextMimeType,
	parseSubfsSubject,
	shouldCompressFile,
} from '@wispplace/atproto-utils'
import { GZIP_COMPRESSION_LEVEL, MAX_FILE_COUNT, MAX_FILE_SIZE } from '@wispplace/constants'
import {
	countFilesInDirectory,
	createManifest,
	estimateDirectorySize,
	type FileUploadResult,
	findLargeDirectories,
	normalizeSitePath,
	processUploadedFiles,
	replaceDirectoryWithSubfs,
	splitDirectoryIntoChunks,
	toSubfsDirectory,
	type UploadedFile,
	updateFileBlobs,
} from '@wispplace/fs-utils'
import type { Directory, Entry } from '@wispplace/lexicons/types/place/wisp/fs'
import { createLogger } from '@wispplace/observability'
import { createIgnoreMatcher, parseWispignore, shouldIgnore } from './ignore-patterns'
import { completeUploadJob, failUploadJob, getUploadJob, updateJobProgress } from './upload-jobs'

const logger = createLogger('main-app')

const MAX_SKIPPED_FILES_REPORTED = 50
const MAX_WISPIGNORE_BYTES = 64 * 1024
const MAX_WISPIGNORE_PATTERNS = 1_000
const MAX_BUFFERED_GZIP_INPUT_BYTES = 16 * 1024 * 1024
const MAX_OWNED_SUBFS_RECORDS = 100
const SUBFS_CONCURRENCY = 4
const MAX_PROGRESS_FILE_NAME_LENGTH = 160
const MAX_MANIFEST_SIZE = 140 * 1024
const MAX_SUBFS_SIZE = 75 * 1024
const SUBFS_CHUNK_TARGET_SIZE = MAX_SUBFS_SIZE - 2 * 1024
const INLINE_FILE_COUNT_TARGET = 200
const ROOT_FILE_BATCH_SIZE = 100
const MAX_MANIFEST_SPLIT_ATTEMPTS = 100
const RESERVED_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

export const INVALID_UPLOAD_MESSAGE = 'Invalid upload'
export const UPLOAD_TOO_LARGE_MESSAGE = 'Upload too large'
export const UPLOAD_BUSY_MESSAGE = 'Upload capacity reached'
export const UPLOAD_UNAVAILABLE_MESSAGE = 'Uploads are temporarily unavailable'
export const UPLOAD_CONFLICT_MESSAGE = 'Upload conflict. Please retry'
export const UPLOAD_FAILED_MESSAGE = 'Upload failed'

export class PublicUploadError extends Error {
	constructor(
		public readonly status: 400 | 409 | 413 | 429 | 500 | 503,
		message: string,
	) {
		super(message)
		this.name = 'PublicUploadError'
	}
}

export interface ValidatedPublicUploadFile {
	file: File
	path: string
	mimeType: string
	size: number
}

interface RawPublicUploadFile extends ValidatedPublicUploadFile {
	rawPath: string
	fromWebkitRelativePath: boolean
}

interface OwnedSubfsSubject {
	uri: string
	rkey: string
	path: string
}

interface ExistingUploadState {
	rootCid: string | null
	blobMap: Map<string, { blobRef: any; cid: string }>
	ownedSubfs: OwnedSubfsSubject[]
}

interface UploadedBlob {
	result: FileUploadResult
	filePath: string
	reused: boolean
}

interface ManifestBuildState {
	directory: Directory
	totalFileCount: number
	inlineFileCount: number
}

interface ManifestCommit {
	record: Awaited<ReturnType<Agent['com']['atproto']['repo']['putRecord']>>
	referencedSubfs: ReadonlySet<string>
}

type IgnoreMatcher = ReturnType<typeof createIgnoreMatcher>
type PutSubfs = (record: Record<string, unknown>) => Promise<string>

function invalidUpload(): never {
	throw new PublicUploadError(400, INVALID_UPLOAD_MESSAGE)
}

function uploadTooLarge(): never {
	throw new PublicUploadError(413, UPLOAD_TOO_LARGE_MESSAGE)
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
}

function throwIfUploadCancelled(jobId: string, signal?: AbortSignal): void {
	throwIfAborted(signal)
	const job = getUploadJob(jobId)
	if (!job || job.status === 'failed' || job.status === 'completed') {
		throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
	}
}

function safeFileLabel(path: string): string {
	if (path.length <= MAX_PROGRESS_FILE_NAME_LENGTH) return path
	return `${path.slice(0, 120)}…${path.slice(-24)}`
}

function hasAsciiControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0
		if (codePoint < 32 || codePoint === 127) return true
	}
	return false
}

function getSafeMimeType(file: File): string {
	const mimeType = typeof file.type === 'string' ? file.type : ''
	if (mimeType.length === 0 || mimeType.length > 255 || hasAsciiControlCharacter(mimeType)) {
		return 'application/octet-stream'
	}
	return mimeType
}

function getUploadPathSource(file: File): { path: string; fromWebkitRelativePath: boolean } | null {
	const webkitRelativePath = (file as File & { webkitRelativePath?: unknown }).webkitRelativePath
	if (typeof webkitRelativePath === 'string' && webkitRelativePath.length > 0) {
		return { path: webkitRelativePath, fromWebkitRelativePath: true }
	}
	if (typeof file.name !== 'string') return null
	return { path: file.name, fromWebkitRelativePath: false }
}

function asFile(candidate: unknown): File | null {
	if (!candidate || typeof candidate !== 'object') return null
	const file = candidate as File
	if (typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string' || typeof file.size !== 'number')
		return null
	return file
}

function validateRawUploadFile(candidate: unknown): RawPublicUploadFile {
	const file = asFile(candidate)
	if (!file) invalidUpload()
	const source = getUploadPathSource(file)
	if (!source) invalidUpload()
	const normalizedPath = normalizeSitePath(source.path)
	if (!normalizedPath || normalizedPath !== source.path) invalidUpload()
	if (!Number.isSafeInteger(file.size) || file.size < 0) invalidUpload()
	return {
		file,
		rawPath: normalizedPath,
		path: normalizedPath,
		fromWebkitRelativePath: source.fromWebkitRelativePath,
		mimeType: getSafeMimeType(file),
		size: file.size,
	}
}

function sharedWebkitDirectoryRoot(files: readonly RawPublicUploadFile[]): string | null {
	if (files.length === 0 || files.some((file) => !file.fromWebkitRelativePath || !file.rawPath.includes('/'))) {
		return null
	}
	const root = files[0]!.rawPath.slice(0, files[0]!.rawPath.indexOf('/'))
	return files.every((file) => file.rawPath.startsWith(`${root}/`)) ? root : null
}

function isReservedInternalSegment(segment: string): boolean {
	const normalized = segment.normalize('NFKC').toLowerCase()
	return normalized.startsWith('__subfs_') || RESERVED_SEGMENTS.has(normalized)
}

function hasReservedInternalPath(path: string): boolean {
	return path.split('/').some(isReservedInternalSegment)
}

function canonicalPath(rawFile: RawPublicUploadFile, sharedRoot: string | null): string {
	const path = sharedRoot ? rawFile.rawPath.slice(sharedRoot.length + 1) : rawFile.rawPath
	const normalizedPath = normalizeSitePath(path)
	if (!normalizedPath || normalizedPath !== path || hasReservedInternalPath(normalizedPath)) invalidUpload()
	return normalizedPath
}

function assertNoPathCollisions(paths: readonly string[]): void {
	const sortedPaths = [...paths].sort()
	for (let index = 1; index < sortedPaths.length; index++) {
		if (
			sortedPaths[index] === sortedPaths[index - 1] ||
			sortedPaths[index]!.startsWith(`${sortedPaths[index - 1]!}/`)
		) {
			invalidUpload()
		}
	}
}

/** Validate multipart metadata before any file body is read. */
export function validatePublicUploadFiles(
	files: readonly unknown[],
	maxLogicalBytes: number,
): ValidatedPublicUploadFile[] {
	if (!Number.isSafeInteger(maxLogicalBytes) || maxLogicalBytes < 0) invalidUpload()
	// Reject a hostile multipart count before touching even file metadata. Bun
	// has already parsed the multipart envelope, but no File body is read here.
	if (files.length > MAX_FILE_COUNT) uploadTooLarge()

	let totalSize = 0
	const rawFiles: RawPublicUploadFile[] = []
	for (const candidate of files) {
		const file = validateRawUploadFile(candidate)
		if (file.size > MAX_FILE_SIZE || file.size > maxLogicalBytes - totalSize) uploadTooLarge()
		totalSize += file.size
		rawFiles.push(file)
	}

	const sharedRoot = sharedWebkitDirectoryRoot(rawFiles)
	const validatedFiles = rawFiles.map((file) => ({ ...file, path: canonicalPath(file, sharedRoot) }))
	assertNoPathCollisions(validatedFiles.map((file) => file.path))
	return validatedFiles
}

function isWispignorePath(path: string): boolean {
	const parts = path.split('/')
	return parts[parts.length - 1] === '.wispignore'
}

function rootWispignoreFile(files: readonly ValidatedPublicUploadFile[]): ValidatedPublicUploadFile | undefined {
	return files.find((file) => file.path === '.wispignore')
}

async function readCustomIgnorePatterns(files: readonly ValidatedPublicUploadFile[]): Promise<string[]> {
	const ignoreFile = rootWispignoreFile(files)
	if (!ignoreFile) return []
	if (ignoreFile.size > MAX_WISPIGNORE_BYTES) invalidUpload()
	try {
		const patterns = parseWispignore(await ignoreFile.file.text())
		if (patterns.length > MAX_WISPIGNORE_PATTERNS) invalidUpload()
		return patterns
	} catch {
		invalidUpload()
	}
}

function createIgnoreMatchers(patterns: string[]): { enforced: IgnoreMatcher; requested: IgnoreMatcher } {
	try {
		return { enforced: createIgnoreMatcher(), requested: createIgnoreMatcher(patterns) }
	} catch {
		invalidUpload()
	}
}

function ignoredFileReason(
	file: ValidatedPublicUploadFile,
	enforced: IgnoreMatcher,
	requested: IgnoreMatcher,
): string | null {
	if (isWispignorePath(file.path)) return 'matched ignore pattern'
	if (shouldIgnore(enforced, file.path)) return 'matched ignore pattern'
	if (shouldIgnore(requested, file.path)) return 'matched ignore pattern'
	return null
}

function addSkippedFile(skippedFiles: Array<{ name: string; reason: string }>, path: string, reason: string): void {
	if (skippedFiles.length < MAX_SKIPPED_FILES_REPORTED) {
		skippedFiles.push({ name: safeFileLabel(path), reason })
	}
}

export async function selectPublicUploadFiles(files: readonly ValidatedPublicUploadFile[]): Promise<{
	files: ValidatedPublicUploadFile[]
	skippedFiles: Array<{ name: string; reason: string }>
}> {
	const patterns = await readCustomIgnorePatterns(files)
	const matchers = createIgnoreMatchers(patterns)
	const selectedFiles: ValidatedPublicUploadFile[] = []
	const skippedFiles: Array<{ name: string; reason: string }> = []

	for (const file of files) {
		const reason = ignoredFileReason(file, matchers.enforced, matchers.requested)
		if (reason) addSkippedFile(skippedFiles, file.path, reason)
		else selectedFiles.push(file)
	}
	return { files: selectedFiles, skippedFiles }
}

function gzipAsync(content: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		gzip(content, { level: GZIP_COMPRESSION_LEVEL }, (error, compressed) => {
			if (error) reject(error)
			else resolve(compressed)
		})
	})
}

function shouldGzip(file: ValidatedPublicUploadFile): boolean {
	// zlib needs the input and output live at once. Keep compression below this
	// bound rather than briefly doubling a 200 MiB upload buffer.
	return shouldCompressFile(file.mimeType, file.path) && file.size <= MAX_BUFFERED_GZIP_INPUT_BYTES
}

async function readFileForUpload(file: ValidatedPublicUploadFile, signal?: AbortSignal): Promise<UploadedFile> {
	throwIfAborted(signal)
	let content = Buffer.from(await file.file.arrayBuffer())
	throwIfAborted(signal)
	if (content.length !== file.size) throw new PublicUploadError(400, INVALID_UPLOAD_MESSAGE)
	if (!shouldGzip(file)) return createUploadedFile(file, content, false)

	const compressed = await gzipAsync(content)
	content = Buffer.alloc(0)
	throwIfAborted(signal)
	return createUploadedFile(file, compressed, true)
}

function createUploadedFile(file: ValidatedPublicUploadFile, content: Buffer, compressed: boolean): UploadedFile {
	return {
		name: file.path,
		content,
		mimeType: file.mimeType,
		size: content.length,
		compressed,
		originalMimeType: file.mimeType,
	}
}

function errorStatus(error: unknown, fallback = 502): number {
	const status = typeof error === 'object' && error !== null ? Number((error as { status?: unknown }).status) : NaN
	return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback
}

function swapConflict(error: unknown): boolean {
	const code = typeof error === 'object' && error !== null ? String((error as { error?: unknown }).error ?? '') : ''
	return errorStatus(error) === 409 || code === 'InvalidSwap' || code === 'SwapConflict'
}

function asPipelineError(error: unknown, rootSwapAttempted = false): PublicUploadError {
	if (error instanceof PublicUploadError) return error
	if (rootSwapAttempted && swapConflict(error)) return new PublicUploadError(409, UPLOAD_CONFLICT_MESSAGE)
	const status = errorStatus(error)
	return status === 413 || status === 419
		? new PublicUploadError(413, UPLOAD_TOO_LARGE_MESSAGE)
		: new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
}

async function runBounded<T>(items: readonly T[], limit: number, operation: (item: T) => Promise<void>): Promise<void> {
	let nextIndex = 0
	const workerCount = Math.min(Math.max(1, limit), items.length)
	const workers = Array.from({ length: workerCount }, async () => {
		while (true) {
			const index = nextIndex++
			if (index >= items.length) return
			await operation(items[index]!)
		}
	})
	await Promise.all(workers)
}

export function collectOwnedSubfsSubjects(directory: Directory, did: string): OwnedSubfsSubject[] {
	const seen = new Set<string>()
	const subjects: OwnedSubfsSubject[] = []
	for (const candidate of extractSubfsUris(directory)) {
		if (subjects.length >= MAX_OWNED_SUBFS_RECORDS) break
		if (candidate.uri.length > 4096) continue
		const subject = parseOwnedSubfsSubject(candidate.uri, did)
		if (!subject || seen.has(subject.uri)) continue
		seen.add(subject.uri)
		subjects.push({ ...subject, path: candidate.path })
	}
	return subjects
}

function parseOwnedSubfsSubject(uri: string, did: string): Omit<OwnedSubfsSubject, 'path'> | null {
	try {
		const subject = parseSubfsSubject(uri)
		if (subject.repo !== did || subject.collection !== 'place.wisp.subfs') return null
		return { uri: subject.uri, rkey: subject.rkey }
	} catch {
		return null
	}
}

function emptyExistingState(rootCid: string | null): ExistingUploadState {
	return { rootCid, blobMap: new Map(), ownedSubfs: [] }
}

function manifestRoot(value: unknown): Directory | null {
	if (!value || typeof value !== 'object' || !('root' in value)) return null
	return (value as { root: Directory }).root
}

function isRecordNotFound(error: unknown): boolean {
	const code = typeof error === 'object' && error !== null ? String((error as { error?: unknown }).error ?? '') : ''
	return code === 'RecordNotFound' || errorStatus(error) === 404
}

function existingRecordCid(record: unknown): string {
	const cid =
		typeof record === 'object' && record !== null && 'data' in record
			? (record as { data?: { cid?: unknown } }).data?.cid
			: undefined
	if (typeof cid !== 'string' || cid.length === 0 || cid.length > 256) {
		throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
	}
	return cid
}

export async function loadExistingUploadState(
	agent: Agent,
	did: string,
	siteName: string,
): Promise<ExistingUploadState> {
	try {
		const record = await agent.com.atproto.repo.getRecord({ repo: did, collection: 'place.wisp.fs', rkey: siteName })
		return await existingStateFromRecord(agent, did, record.data.value, existingRecordCid(record))
	} catch (error) {
		if (isRecordNotFound(error)) return emptyExistingState(null)
		logger.warn('Unable to inspect existing manifest', { errorKind: 'existing_manifest_fetch_failed' })
		throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
	}
}

async function existingStateFromRecord(
	agent: Agent,
	did: string,
	value: unknown,
	rootCid: string,
): Promise<ExistingUploadState> {
	const root = manifestRoot(value)
	if (!root) return emptyExistingState(rootCid)
	const state: ExistingUploadState = {
		rootCid,
		blobMap: extractBlobMap(root),
		ownedSubfs: collectOwnedSubfsSubjects(root, did),
	}
	await mergeOwnedSubfsBlobMaps(agent, did, state)
	return state
}

async function mergeOwnedSubfsBlobMaps(agent: Agent, did: string, state: ExistingUploadState): Promise<void> {
	await runBounded(state.ownedSubfs, SUBFS_CONCURRENCY, async (subject) => {
		const root = await fetchOwnedSubfsRoot(agent, did, subject.rkey)
		if (!root) return
		extractBlobMap(root, subject.path).forEach((blob, path) => {
			state.blobMap.set(path, blob)
		})
	})
}

async function fetchOwnedSubfsRoot(agent: Agent, did: string, rkey: string): Promise<Directory | null> {
	try {
		const record = await agent.com.atproto.repo.getRecord({ repo: did, collection: 'place.wisp.subfs', rkey })
		return manifestRoot(record.data.value)
	} catch {
		logger.warn('Failed to fetch an owned SubFS record for blob reuse', { errorKind: 'subfs_reuse_fetch_failed' })
		return null
	}
}

function createMetadataDirectory(files: readonly ValidatedPublicUploadFile[]): {
	directory: Directory
	fileCount: number
} {
	const metadataFiles = files.map((file) => createUploadedFile(file, Buffer.alloc(0), false))
	return processUploadedFiles(metadataFiles, { skipNormalization: true })
}

function uploadMimeType(file: UploadedFile): string {
	return file.compressed || file.mimeType.startsWith('text/html') ? 'application/octet-stream' : file.mimeType
}

function reuseResult(file: UploadedFile, existing: { blobRef: any; cid: string }): FileUploadResult {
	return {
		hash: existing.cid,
		blobRef: existing.blobRef,
		...(file.compressed && { encoding: 'gzip' as const, mimeType: file.originalMimeType || file.mimeType }),
		base64: !!file.base64Encoded,
	}
}

function shouldRetryBlobUpload(status: number, attempt: number): boolean {
	return attempt < 4 && [408, 409, 429].includes(status)
}

function waitForBlobRetry(attempt: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener('abort', abort)
		const timer = setTimeout(
			() => {
				cleanup()
				resolve()
			},
			Math.min(2_000 * 2 ** attempt, 16_000),
		)
		const abort = () => {
			clearTimeout(timer)
			cleanup()
			reject(new PublicUploadError(500, UPLOAD_FAILED_MESSAGE))
		}
		if (signal?.aborted) return abort()
		signal?.addEventListener('abort', abort, { once: true })
	})
}

async function uploadBlobWithRetry(
	agent: Agent,
	content: Buffer,
	mimeType: string,
	path: string,
	signal?: AbortSignal,
): Promise<FileUploadResult> {
	for (let attempt = 0; attempt < 5; attempt++) {
		throwIfAborted(signal)
		try {
			const response = await agent.com.atproto.repo.uploadBlob(content, { encoding: mimeType })
			return { hash: response.data.blob.ref.toString(), blobRef: response.data.blob, base64: false }
		} catch (error) {
			const status = errorStatus(error)
			if (status === 413 || status === 419) throw new PublicUploadError(413, UPLOAD_TOO_LARGE_MESSAGE)
			if (shouldRetryBlobUpload(status, attempt)) {
				await waitForBlobRetry(attempt, signal)
				continue
			}
			logger.warn('PDS blob upload failed', { errorKind: 'blob_upload_failed', status, path: safeFileLabel(path) })
			throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
		}
	}
	throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
}

async function uploadOneFile(
	jobId: string,
	input: ValidatedPublicUploadFile,
	index: number,
	total: number,
	existingBlobMap: ExistingUploadState['blobMap'],
	agent: Agent,
	signal?: AbortSignal,
): Promise<UploadedBlob> {
	throwIfUploadCancelled(jobId, signal)
	const prepared = await readFileForUpload(input, signal)
	throwIfUploadCancelled(jobId, signal)
	updateJobProgress(jobId, {
		filesProcessed: index + 1,
		currentFile: `${index + 1}/${total}: ${safeFileLabel(input.path)}`,
	})
	try {
		return await uploadPreparedFile(jobId, prepared, input.path, index, total, existingBlobMap, agent, signal)
	} finally {
		prepared.content = Buffer.alloc(0)
	}
}

async function uploadPreparedFile(
	jobId: string,
	file: UploadedFile,
	path: string,
	index: number,
	total: number,
	existingBlobMap: ExistingUploadState['blobMap'],
	agent: Agent,
	signal?: AbortSignal,
): Promise<UploadedBlob> {
	throwIfUploadCancelled(jobId, signal)
	const existing = existingBlobMap.get(path)
	if (existing?.cid === computeCID(file.content)) return markReusedFile(jobId, file, path, index, total, existing)
	return await putPreparedFile(jobId, file, path, index, total, agent, signal)
}

function markReusedFile(
	jobId: string,
	file: UploadedFile,
	path: string,
	index: number,
	total: number,
	existing: { blobRef: any; cid: string },
): UploadedBlob {
	const filesReused = (getUploadJob(jobId)?.progress.filesReused ?? 0) + 1
	updateJobProgress(jobId, { filesReused, currentFile: `${index + 1}/${total}: ${safeFileLabel(path)} (reused)` })
	return { result: reuseResult(file, existing), filePath: path, reused: true }
}

async function putPreparedFile(
	jobId: string,
	file: UploadedFile,
	path: string,
	index: number,
	total: number,
	agent: Agent,
	signal?: AbortSignal,
): Promise<UploadedBlob> {
	throwIfUploadCancelled(jobId, signal)
	const result = await uploadBlobWithRetry(agent, file.content, uploadMimeType(file), path, signal)
	throwIfUploadCancelled(jobId, signal)
	if (file.compressed) {
		result.encoding = 'gzip'
		result.mimeType = file.originalMimeType || file.mimeType
	}
	const filesUploaded = (getUploadJob(jobId)?.progress.filesUploaded ?? 0) + 1
	updateJobProgress(jobId, { filesUploaded, currentFile: `${index + 1}/${total}: ${safeFileLabel(path)} (uploaded)` })
	return { result, filePath: path, reused: false }
}

async function uploadAllFiles(
	jobId: string,
	files: readonly ValidatedPublicUploadFile[],
	existingState: ExistingUploadState,
	agent: Agent,
	signal?: AbortSignal,
): Promise<UploadedBlob[]> {
	const uploadedBlobs: UploadedBlob[] = []
	updateJobProgress(jobId, { phase: 'compressing', totalFiles: files.length })
	for (const [index, file] of files.entries()) {
		uploadedBlobs.push(await uploadOneFile(jobId, file, index, files.length, existingState.blobMap, agent, signal))
	}
	return uploadedBlobs
}

function updatedDirectoryForBlobs(
	directory: Directory,
	blobs: readonly UploadedBlob[],
	expectedFileCount: number,
): Directory {
	const results = blobs.map((blob) => blob.result)
	const paths = blobs.map((blob) => blob.filePath)
	const updatedDirectory = updateFileBlobs(directory, results, paths, '', undefined, { skipNormalization: true })
	if (countFilesInDirectory(updatedDirectory) !== expectedFileCount)
		throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
	return updatedDirectory
}

function manifestForState(siteName: string, state: ManifestBuildState) {
	return createManifest(siteName, state.directory, state.totalFileCount)
}

function manifestNeedsSplit(siteName: string, state: ManifestBuildState): boolean {
	return (
		state.inlineFileCount > INLINE_FILE_COUNT_TARGET ||
		JSON.stringify(manifestForState(siteName, state)).length > MAX_MANIFEST_SIZE
	)
}

function assertManifestFits(siteName: string, state: ManifestBuildState): void {
	if (manifestNeedsSplit(siteName, state)) throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
}

function largestDirectory(directory: Directory) {
	return findLargeDirectories(directory).sort((left, right) => right.size - left.size)[0] ?? null
}

function directoryContainsSubfs(directory: Directory): boolean {
	return directory.entries.some((entry) => nodeContainsSubfs(entry.node))
}

function nodeContainsSubfs(node: Entry['node']): boolean {
	if (!('type' in node)) return false
	if (node.type === 'subfs') return true
	return node.type === 'directory' && directoryContainsSubfs(node as Directory)
}

function makeFlatSubfsEntry(name: string, subject: string): Entry {
	return {
		name,
		node: { $type: 'place.wisp.fs#subfs', type: 'subfs', subject, flat: true },
	}
}

function replaceDirectoryEntries(directory: Directory, targetPath: string, entries: Entry[]): Directory {
	return replaceDirectoryEntriesAtPath(directory, targetPath.split('/'), entries)
}

function replaceDirectoryEntriesAtPath(directory: Directory, path: readonly string[], entries: Entry[]): Directory {
	if (path.length === 0) return { ...directory, entries }
	const [head, ...tail] = path
	return {
		...directory,
		entries: directory.entries.map((entry) => replaceMatchingDirectoryEntry(entry, head!, tail, entries)),
	}
}

function replaceMatchingDirectoryEntry(entry: Entry, head: string, tail: readonly string[], entries: Entry[]): Entry {
	if (entry.name !== head || !('type' in entry.node) || entry.node.type !== 'directory') return entry
	return {
		...entry,
		node: {
			...replaceDirectoryEntriesAtPath(entry.node as Directory, tail, entries),
			$type: 'place.wisp.fs#directory',
		},
	}
}

function assertChunksFit(chunks: readonly Directory[]): void {
	if (chunks.length < 2 || chunks.some((chunk) => estimateDirectorySize(chunk) > MAX_SUBFS_SIZE)) {
		throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
	}
}

async function splitLargeDirectory(
	state: ManifestBuildState,
	target: NonNullable<ReturnType<typeof largestDirectory>>,
	putSubfs: PutSubfs,
	splitId: number,
): Promise<ManifestBuildState> {
	if (directoryContainsSubfs(target.directory)) throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
	const chunks = splitDirectoryIntoChunks(target.directory, SUBFS_CHUNK_TARGET_SIZE)
	assertChunksFit(chunks)
	const entries: Entry[] = []
	for (const [index, chunk] of chunks.entries()) {
		const subject = await putSubfs({
			$type: 'place.wisp.subfs',
			root: toSubfsDirectory(chunk),
			fileCount: countFilesInDirectory(chunk),
			createdAt: new Date().toISOString(),
		})
		entries.push(makeFlatSubfsEntry(`__subfs_${splitId}_${index}`, subject))
	}
	return {
		...state,
		directory: replaceDirectoryEntries(state.directory, target.path, entries),
		inlineFileCount: state.inlineFileCount - target.fileCount,
	}
}

async function splitWholeDirectory(
	state: ManifestBuildState,
	target: NonNullable<ReturnType<typeof largestDirectory>>,
	putSubfs: PutSubfs,
): Promise<ManifestBuildState> {
	if (directoryContainsSubfs(target.directory)) throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
	const subject = await putSubfs({
		$type: 'place.wisp.subfs',
		root: toSubfsDirectory(target.directory),
		fileCount: target.fileCount,
		createdAt: new Date().toISOString(),
	})
	return {
		...state,
		directory: replaceDirectoryWithSubfs(state.directory, target.path, subject),
		inlineFileCount: state.inlineFileCount - target.fileCount,
	}
}

async function splitDirectoryState(
	state: ManifestBuildState,
	target: NonNullable<ReturnType<typeof largestDirectory>>,
	putSubfs: PutSubfs,
	splitId: number,
): Promise<ManifestBuildState> {
	return target.size > MAX_SUBFS_SIZE
		? await splitLargeDirectory(state, target, putSubfs, splitId)
		: await splitWholeDirectory(state, target, putSubfs)
}

function rootFileEntries(directory: Directory): Entry[] {
	return directory.entries.filter((entry) => 'type' in entry.node && entry.node.type === 'file')
}

async function splitRootFileState(
	state: ManifestBuildState,
	putSubfs: PutSubfs,
	splitId: number,
): Promise<ManifestBuildState> {
	const rootFiles = rootFileEntries(state.directory)
	if (rootFiles.length === 0) throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
	const batch = rootFiles.slice(0, ROOT_FILE_BATCH_SIZE)
	const subject = await putSubfs({
		$type: 'place.wisp.subfs',
		root: toSubfsDirectory({ $type: 'place.wisp.fs#directory', type: 'directory', entries: batch }),
		fileCount: batch.length,
		createdAt: new Date().toISOString(),
	})
	const remaining = state.directory.entries.filter((entry) => !batch.includes(entry))
	return {
		...state,
		directory: { ...state.directory, entries: [...remaining, makeFlatSubfsEntry(`__subfs_${splitId}_0`, subject)] },
		inlineFileCount: state.inlineFileCount - batch.length,
	}
}

async function splitManifestOnce(
	state: ManifestBuildState,
	putSubfs: PutSubfs,
	splitId: number,
): Promise<ManifestBuildState> {
	const target = largestDirectory(state.directory)
	return target
		? await splitDirectoryState(state, target, putSubfs, splitId)
		: await splitRootFileState(state, putSubfs, splitId)
}

async function planManifest(
	siteName: string,
	directory: Directory,
	totalFileCount: number,
	putSubfs: PutSubfs,
): Promise<ManifestBuildState> {
	let state: ManifestBuildState = { directory, totalFileCount, inlineFileCount: totalFileCount }
	for (let attempt = 0; attempt < MAX_MANIFEST_SPLIT_ATTEMPTS && manifestNeedsSplit(siteName, state); attempt++) {
		state = await splitManifestOnce(state, putSubfs, attempt + 1)
	}
	assertManifestFits(siteName, state)
	return state
}

async function generatedSubfsAreUnreferenced(
	agent: Agent,
	did: string,
	siteName: string,
	generatedUris: ReadonlySet<string>,
): Promise<boolean> {
	try {
		const record = await agent.com.atproto.repo.getRecord({ repo: did, collection: 'place.wisp.fs', rkey: siteName })
		const root = manifestRoot(record.data.value)
		if (!root) return false
		return !extractSubfsUris(root).some((reference) => generatedUris.has(reference.uri))
	} catch (error) {
		const code = typeof error === 'object' && error !== null ? String((error as { error?: unknown }).error ?? '') : ''
		return code === 'RecordNotFound'
	}
}

async function cleanupGeneratedSubfs(
	agent: Agent,
	did: string,
	siteName: string,
	rkeys: ReadonlySet<string>,
): Promise<void> {
	const generatedUris = new Set(Array.from(rkeys, (rkey) => `at://${did}/place.wisp.subfs/${rkey}`))
	if (!(await generatedSubfsAreUnreferenced(agent, did, siteName, generatedUris))) return
	await runBounded(Array.from(rkeys), SUBFS_CONCURRENCY, async (rkey) => {
		try {
			await agent.com.atproto.repo.deleteRecord({ repo: did, collection: 'place.wisp.subfs', rkey })
		} catch {
			logger.warn('Failed to clean up a newly-created SubFS record', { errorKind: 'subfs_cleanup_failed' })
		}
	})
}

export async function commitPublicUploadManifest(
	agent: Agent,
	did: string,
	siteName: string,
	directory: Directory,
	totalFileCount: number,
	jobId?: string,
	signal?: AbortSignal,
	expectedRootCid: string | null = null,
): Promise<ManifestCommit> {
	throwIfAborted(signal)
	const createdRkeys = new Set<string>()
	const referencedSubfs = new Set<string>()
	const putSubfs: PutSubfs = async (record) => {
		throwIfAborted(signal)
		const rkey = TID.nextStr()
		createdRkeys.add(rkey)
		await agent.com.atproto.repo.putRecord({ repo: did, collection: 'place.wisp.subfs', rkey, record })
		throwIfAborted(signal)
		const uri = `at://${did}/place.wisp.subfs/${rkey}`
		referencedSubfs.add(uri)
		return uri
	}

	let rootSwapAttempted = false
	try {
		if (jobId) updateJobProgress(jobId, { phase: 'creating_manifest' })
		const state = await planManifest(siteName, directory, totalFileCount, putSubfs)
		throwIfAborted(signal)
		if (jobId) updateJobProgress(jobId, { phase: 'finalizing' })
		rootSwapAttempted = true
		const record = await agent.com.atproto.repo.putRecord({
			repo: did,
			collection: 'place.wisp.fs',
			rkey: siteName,
			record: manifestForState(siteName, state),
			swapRecord: expectedRootCid,
		})
		return { record, referencedSubfs }
	} catch (error) {
		// Shutdown cancellation must not start extra PDS cleanup calls. Any
		// pre-root records are unreferenced and may be safely collected later.
		if (!signal?.aborted) await cleanupGeneratedSubfs(agent, did, siteName, createdRkeys)
		throw asPipelineError(error, rootSwapAttempted)
	}
}

function fallbackEligible(file: ValidatedPublicUploadFile): boolean {
	return shouldGzip(file) && isTextMimeType(file.mimeType)
}

async function base64FallbackBlob(
	agent: Agent,
	input: ValidatedPublicUploadFile,
	signal?: AbortSignal,
): Promise<FileUploadResult> {
	const prepared = await readFileForUpload(input, signal)
	try {
		if (!prepared.compressed) throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
		const content = Buffer.from(prepared.content.toString('base64'), 'ascii')
		const result = await uploadBlobWithRetry(agent, content, 'application/octet-stream', input.path, signal)
		result.encoding = 'gzip'
		result.mimeType = input.mimeType
		result.base64 = true
		return result
	} finally {
		prepared.content = Buffer.alloc(0)
	}
}

async function base64FallbackBlobs(
	agent: Agent,
	files: readonly ValidatedPublicUploadFile[],
	blobs: readonly UploadedBlob[],
	signal?: AbortSignal,
): Promise<UploadedBlob[]> {
	const fallback = blobs.map((blob) => ({ ...blob, result: { ...blob.result } }))
	for (const file of files) {
		throwIfAborted(signal)
		if (!fallbackEligible(file)) continue
		const index = fallback.findIndex((blob) => blob.filePath === file.path)
		if (index === -1) throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
		fallback[index] = { ...fallback[index]!, result: await base64FallbackBlob(agent, file, signal) }
	}
	return fallback
}

async function commitWithBase64Fallback(
	agent: Agent,
	did: string,
	siteName: string,
	directory: Directory,
	files: readonly ValidatedPublicUploadFile[],
	blobs: readonly UploadedBlob[],
	jobId: string,
	signal: AbortSignal | undefined,
	expectedRootCid: string | null,
): Promise<ManifestCommit> {
	try {
		return await commitPublicUploadManifest(
			agent,
			did,
			siteName,
			directory,
			blobs.length,
			jobId,
			signal,
			expectedRootCid,
		)
	} catch (error) {
		if (errorStatus(error) !== 500) throw error
		const fallback = await base64FallbackBlobs(agent, files, blobs, signal)
		const fallbackDirectory = updatedDirectoryForBlobs(directory, fallback, files.length)
		return await commitPublicUploadManifest(
			agent,
			did,
			siteName,
			fallbackDirectory,
			fallback.length,
			jobId,
			signal,
			expectedRootCid,
		)
	}
}

function uploadFailure(error: unknown): { message: string; status: number } {
	if (!(error instanceof PublicUploadError)) return { message: UPLOAD_FAILED_MESSAGE, status: 500 }
	if (error.status === 413) return { message: UPLOAD_TOO_LARGE_MESSAGE, status: 413 }
	if (error.status === 409) return { message: UPLOAD_CONFLICT_MESSAGE, status: 409 }
	return { message: UPLOAD_FAILED_MESSAGE, status: error.status }
}

export async function processUploadInBackground(
	jobId: string,
	agent: Agent,
	did: string,
	siteName: string,
	files: ValidatedPublicUploadFile[],
	skippedFiles: Array<{ name: string; reason: string }>,
	signal?: AbortSignal,
): Promise<void> {
	try {
		throwIfUploadCancelled(jobId, signal)
		const existingState = await loadExistingUploadState(agent, did, siteName)
		throwIfUploadCancelled(jobId, signal)
		const metadata = createMetadataDirectory(files)
		if (metadata.fileCount !== files.length) throw new PublicUploadError(500, UPLOAD_FAILED_MESSAGE)
		const blobs = await uploadAllFiles(jobId, files, existingState, agent, signal)
		throwIfUploadCancelled(jobId, signal)
		const directory = updatedDirectoryForBlobs(metadata.directory, blobs, metadata.fileCount)
		const committed = await commitWithBase64Fallback(
			agent,
			did,
			siteName,
			directory,
			files,
			blobs,
			jobId,
			signal,
			existingState.rootCid,
		)
		throwIfUploadCancelled(jobId, signal)
		completeUploadJob(jobId, {
			success: true,
			uri: committed.record.data.uri,
			cid: committed.record.data.cid,
			fileCount: metadata.fileCount,
			siteName,
			skippedFiles,
			uploadedCount: files.length,
			hasFailures: false,
		})
	} catch (error) {
		logger.error('Public upload job failed', { errorKind: 'upload_failed' })
		const failure = uploadFailure(error)
		failUploadJob(jobId, failure.message, failure.status)
	}
}
