import { Agent } from '@atproto/api'
import { TID } from '@atproto/common-web'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import {
	compressFile,
	computeCID,
	extractBlobMap,
	extractSubfsUris,
	isTextMimeType,
	shouldCompressFile,
} from '@wispplace/atproto-utils'
// import { validateRecord as validateSubfsRecord } from '@wispplace/lexicons/types/place/wisp/subfs'
import { MAX_FILE_COUNT, MAX_FILE_SIZE, MAX_SITE_SIZE } from '@wispplace/constants'
import {
	countFilesInDirectory,
	createManifest,
	type FileUploadResult,
	findLargeDirectories,
	processUploadedFiles,
	replaceDirectoryWithSubfs,
	splitDirectoryIntoChunks,
	toSubfsDirectory,
	type UploadedFile,
	updateFileBlobs,
} from '@wispplace/fs-utils'
// import { validateRecord, type Directory } from '@wispplace/lexicons/types/place/wisp/fs'
import type { Directory } from '@wispplace/lexicons/types/place/wisp/fs'
import { createLogger } from '@wispplace/observability'
import {
	buildPublicationWellKnownFile,
	buildWispSiteUrl,
	detectStandardSite,
	publishStandardSite,
	type RepoAgent,
	type StaticSiteFile,
	stripUploadRoot,
	type UploadedBlobReference,
} from '@wispplace/standard-site'
import { Elysia } from 'elysia'
import { createIgnoreMatcher, parseWispignore, shouldIgnore } from '../lib/ignore-patterns'
import {
	addJobListener,
	completeUploadJob,
	createUploadJob,
	failUploadJob,
	getUploadJob,
	updateJobProgress,
} from '../lib/upload-jobs'
import { requireAuth } from '../lib/wisp-auth'

const logger = createLogger('main-app')

type StandardSiteUploadSummary = NonNullable<Parameters<typeof completeUploadJob>[1]>['standardSite']

export function isValidSiteName(siteName: string): boolean {
	if (!siteName || typeof siteName !== 'string') return false

	// Length check (AT Protocol rkey limit)
	if (siteName.length < 1 || siteName.length > 512) return false

	// Check for path traversal
	if (siteName === '.' || siteName === '..') return false
	if (siteName.includes('/') || siteName.includes('\\')) return false
	if (siteName.includes('\0')) return false

	// AT Protocol rkey format: alphanumeric, dots, dashes, underscores, tildes, colons
	// Based on NSID format rules
	const validRkeyPattern = /^[a-zA-Z0-9._~:-]+$/
	if (!validRkeyPattern.test(siteName)) return false

	return true
}

function parseBooleanFormValue(value: unknown): boolean {
	if (typeof value === 'boolean') return value
	if (typeof value === 'string') return value === 'true' || value === '1' || value === 'on'
	return false
}

function getFileUploadPath(file: File): string {
	const webkitPath = 'webkitRelativePath' in file ? String(file.webkitRelativePath) : ''
	return webkitPath || file.name
}

function inferSharedUploadRoot(files: File[]): string | undefined {
	const paths = files.map(getFileUploadPath).filter((path) => path.includes('/'))
	if (paths.length === 0 || paths.length !== files.length) return undefined

	const root = paths[0]?.split('/')[0]
	if (!root) return undefined

	return paths.every((path) => path.split('/')[0] === root) ? root : undefined
}

function withUploadRoot(path: string, uploadRoot: string | undefined): string {
	return uploadRoot ? `${uploadRoot}/${path}` : `./${path}`
}

async function processUploadInBackground(
	jobId: string,
	agent: Agent,
	did: string,
	siteName: string,
	fileArray: File[],
	publishStandardSiteRecords: boolean,
): Promise<void> {
	try {
		// Try to fetch existing record to enable incremental updates
		let existingBlobMap = new Map<string, { blobRef: any; cid: string }>()
		let oldSubfsUris: Array<{ uri: string; path: string }> = []
		console.log('Attempting to fetch existing record...')
		updateJobProgress(jobId, { phase: 'validating' })

		try {
			const rkey = siteName
			const existingRecord = await agent.com.atproto.repo.getRecord({
				repo: did,
				collection: 'place.wisp.fs',
				rkey: rkey,
			})
			console.log('Existing record found!')

			if (
				existingRecord.data.value &&
				typeof existingRecord.data.value === 'object' &&
				'root' in existingRecord.data.value
			) {
				const manifest = existingRecord.data.value as any

				// Extract blob map from main record
				existingBlobMap = extractBlobMap(manifest.root)
				console.log(`Found existing manifest with ${existingBlobMap.size} files in main record`)

				// Extract subfs URIs with their mount paths from main record
				const subfsUris = extractSubfsUris(manifest.root)
				oldSubfsUris = subfsUris // Save for cleanup later

				if (subfsUris.length > 0) {
					console.log(`Found ${subfsUris.length} subfs records, fetching in parallel...`)
					logger.info(`Fetching ${subfsUris.length} subfs records for blob reuse`)

					// Fetch all subfs records in parallel
					const subfsRecords = await Promise.all(
						subfsUris.map(async ({ uri, path }) => {
							try {
								// Parse URI: at://did/collection/rkey
								const parts = uri.replace('at://', '').split('/')
								const subDid = parts[0]
								const collection = parts[1]
								const subRkey = parts[2]

								const record = await agent.com.atproto.repo.getRecord({
									repo: subDid,
									collection: collection,
									rkey: subRkey,
								})

								return { record: record.data.value as any, mountPath: path }
							} catch (err: any) {
								logger.warn(`Failed to fetch subfs record ${uri}: ${err?.message}`, err)
								return null
							}
						}),
					)

					// Merge blob maps from all subfs records
					let totalSubfsBlobs = 0
					for (const subfsData of subfsRecords) {
						if (subfsData?.record && 'root' in subfsData.record) {
							// Extract blobs with the correct mount path prefix
							const subfsMap = extractBlobMap(subfsData.record.root, subfsData.mountPath)
							subfsMap.forEach((value, key) => {
								existingBlobMap.set(key, value)
								totalSubfsBlobs++
							})
						}
					}

					console.log(`Merged ${totalSubfsBlobs} files from ${subfsUris.length} subfs records`)
					logger.info(`Total blob map: ${existingBlobMap.size} files (main + subfs)`)
				}

				console.log(`Total existing blobs for reuse: ${existingBlobMap.size} files`)
				logger.info(`Found existing manifest with ${existingBlobMap.size} files for incremental update`)
			}
		} catch (error: any) {
			console.log('No existing record found or error:', error?.message || error)
			if (error?.status !== 400 && error?.error !== 'RecordNotFound') {
				logger.warn('Failed to fetch existing record, proceeding with full upload', error)
			}
		}

		// Check for .wispignore file in uploaded files
		let customIgnorePatterns: string[] = []
		const wispignoreFile = fileArray.find((f) => f?.name?.endsWith('.wispignore'))
		if (wispignoreFile) {
			try {
				const content = await wispignoreFile.text()
				customIgnorePatterns = parseWispignore(content)
				console.log(`Found .wispignore file with ${customIgnorePatterns.length} custom patterns`)
			} catch (err) {
				console.warn('Failed to parse .wispignore file:', err)
			}
		}

		// Create ignore matcher with default and custom patterns
		const ignoreMatcher = createIgnoreMatcher(customIgnorePatterns)

		// Convert File objects to UploadedFile format
		const uploadedFiles: UploadedFile[] = []
		const standardSiteFiles: StaticSiteFile[] = []
		const skippedFiles: Array<{ name: string; reason: string }> = []
		let standardSiteSummary: StandardSiteUploadSummary = publishStandardSiteRecords
			? {
					enabled: true,
					detected: false,
					posts: 0,
				}
			: undefined

		console.log('Processing files, count:', fileArray.length)
		updateJobProgress(jobId, { phase: 'compressing' })

		for (let i = 0; i < fileArray.length; i++) {
			const file = fileArray[i]

			// Skip undefined/null files
			if (!file || !file.name) {
				console.log(`Skipping undefined file at index ${i}`)
				skippedFiles.push({
					name: `[undefined file at index ${i}]`,
					reason: 'Invalid file object',
				})
				continue
			}

			const filePath = getFileUploadPath(file)

			updateJobProgress(jobId, {
				filesProcessed: i + 1,
				currentFile: filePath,
			})

			// Skip files that match ignore patterns
			const normalizedPath = filePath.replace(/^[^/]*\//, '')

			if (shouldIgnore(ignoreMatcher, normalizedPath)) {
				skippedFiles.push({
					name: filePath,
					reason: 'matched ignore pattern',
				})
				continue
			}

			// Skip files that are too large
			const maxSize = MAX_FILE_SIZE
			if (file.size > maxSize) {
				skippedFiles.push({
					name: filePath,
					reason: `file too large (${(file.size / 1024 / 1024).toFixed(2)}MB, max 100MB)`,
				})
				continue
			}

			const arrayBuffer = await file.arrayBuffer()
			const originalContent = Buffer.from(arrayBuffer)
			const originalMimeType = file.type || 'application/octet-stream'
			standardSiteFiles.push({
				path: filePath,
				content: originalContent,
				mimeType: originalMimeType,
				size: originalContent.length,
			})

			// Determine if file should be compressed (pass filename to exclude _redirects)
			const shouldCompress = shouldCompressFile(originalMimeType, normalizedPath)

			let finalContent: Buffer
			let compressed = false

			if (shouldCompress) {
				finalContent = compressFile(originalContent)
				compressed = true
			} else {
				finalContent = originalContent
			}

			uploadedFiles.push({
				name: filePath,
				content: finalContent,
				mimeType: originalMimeType,
				size: finalContent.length,
				compressed,
				originalMimeType,
			})
		}

		if (publishStandardSiteRecords) {
			const siteUrl = buildWispSiteUrl(did, siteName)
			const detected = detectStandardSite({
				siteUrl,
				siteName,
				files: standardSiteFiles,
			})

			standardSiteSummary = {
				enabled: true,
				detected: detected.detected,
				posts: detected.posts.length,
				score: detected.score,
			}

			if (detected.detected) {
				const uploadRoot = inferSharedUploadRoot(fileArray)
				const wellKnown = buildPublicationWellKnownFile(did, siteName)
				const wellKnownContent = Buffer.from(String(wellKnown.content))
				const wellKnownPath = withUploadRoot(wellKnown.path, uploadRoot)

				uploadedFiles.push({
					name: wellKnownPath,
					content: wellKnownContent,
					mimeType: wellKnown.mimeType ?? 'text/plain;charset=utf-8',
					size: wellKnownContent.length,
					originalMimeType: wellKnown.mimeType ?? 'text/plain;charset=utf-8',
				})
				standardSiteFiles.push({
					...wellKnown,
					path: wellKnownPath,
					content: wellKnownContent,
					size: wellKnownContent.length,
				})

				logger.info(`[StandardSite] Detected ${detected.posts.length} posts for ${did}/${siteName}`)
			} else {
				logger.info(`[StandardSite] No blog posts detected for ${did}/${siteName}`)
			}
		}

		// Update total file count after filtering (important for progress tracking)
		updateJobProgress(jobId, {
			totalFiles: uploadedFiles.length,
		})

		// Check total size limit
		const totalSize = uploadedFiles.reduce((sum, file) => sum + file.size, 0)
		const maxTotalSize = MAX_SITE_SIZE

		if (totalSize > maxTotalSize) {
			throw new Error(`Total upload size ${(totalSize / 1024 / 1024).toFixed(2)}MB exceeds 300MB limit`)
		}

		// Check file count limit
		if (uploadedFiles.length > MAX_FILE_COUNT) {
			throw new Error(`File count ${uploadedFiles.length} exceeds ${MAX_FILE_COUNT} files limit`)
		}

		console.log(`After filtering: ${uploadedFiles.length} files to process (${skippedFiles.length} skipped)`)

		if (uploadedFiles.length === 0) {
			// Create empty manifest
			const emptyManifest = {
				$type: 'place.wisp.fs',
				site: siteName,
				root: {
					type: 'directory',
					entries: [],
				},
				fileCount: 0,
				createdAt: new Date().toISOString(),
			}

			// const validationResult = validateRecord(emptyManifest);
			// if (!validationResult.success) {
			//     throw new Error(`Invalid manifest: ${validationResult.error?.message || 'Validation failed'}`);
			// }

			const rkey = siteName
			updateJobProgress(jobId, { phase: 'finalizing' })

			const record = await agent.com.atproto.repo.putRecord({
				repo: did,
				collection: 'place.wisp.fs',
				rkey: rkey,
				record: emptyManifest,
			})

			completeUploadJob(jobId, {
				success: true,
				uri: record.data.uri,
				cid: record.data.cid,
				fileCount: 0,
				siteName,
				skippedFiles,
			})
			return
		}

		// Process files into directory structure
		console.log('Processing uploaded files into directory structure...')
		const validUploadedFiles = uploadedFiles.filter((f, i) => {
			if (!f || !f.name || !f.content) {
				console.error(`Filtering out invalid file at index ${i}`)
				return false
			}
			return true
		})

		const { directory, fileCount } = processUploadedFiles(validUploadedFiles)
		console.log('Directory structure created, file count:', fileCount)

		// Upload files as blobs with retry logic for DPoP nonce conflicts
		console.log('Starting blob upload/reuse phase...')
		updateJobProgress(jobId, { phase: 'uploading' })

		// Helper function to upload blob with exponential backoff retry and timeout
		const uploadBlobWithRetry = async (
			agent: Agent,
			content: Buffer,
			mimeType: string,
			fileName: string,
			maxRetries = 5,
		) => {
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				const controller = new AbortController()
				const timeoutMs = 300000 // 5 minute timeout per upload
				const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

				try {
					console.log(
						`[File Upload] Starting upload attempt ${attempt + 1}/${maxRetries} for ${fileName} (${content.length} bytes, ${mimeType})`,
					)

					const result = await agent.com.atproto.repo.uploadBlob(content, { encoding: mimeType })
					clearTimeout(timeoutId)
					console.log(`[File Upload] ✅ Successfully uploaded ${fileName} on attempt ${attempt + 1}`)
					return result
				} catch (error: any) {
					clearTimeout(timeoutId)

					const isDPoPNonceError =
						error?.message?.toLowerCase().includes('nonce') ||
						error?.message?.toLowerCase().includes('dpop') ||
						error?.status === 409

					const isTimeout = error?.name === 'AbortError' || error?.message === 'Upload timeout'
					const isRateLimited = error?.status === 429 || error?.message?.toLowerCase().includes('rate')
					const isRequestEntityTooLarge = error?.status === 419 || error?.status === 413

					// Special handling for 419/413 Request Entity Too Large errors
					if (isRequestEntityTooLarge) {
						const customError = new Error(
							'Your PDS is not allowing uploads large enough to store your site. Please contact your PDS host. This could also possibly be a result of it being behind Cloudflare free tier.',
						)
						;(customError as any).status = 419
						throw customError
					}

					// Retry on DPoP nonce conflicts, timeouts, or rate limits
					if ((isDPoPNonceError || isTimeout || isRateLimited) && attempt < maxRetries - 1) {
						let backoffMs: number
						if (isRateLimited) {
							backoffMs = 2000 * 2 ** attempt // 2s, 4s, 8s, 16s for rate limits
						} else if (isTimeout) {
							backoffMs = 1000 * 2 ** attempt // 1s, 2s, 4s, 8s for timeouts
						} else {
							backoffMs = 100 * 2 ** attempt // 100ms, 200ms, 400ms for DPoP
						}

						const reason = isDPoPNonceError ? 'DPoP nonce conflict' : isTimeout ? 'timeout' : 'rate limit'
						logger.info(
							`[File Upload] 🔄 ${reason} for ${fileName}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`,
						)
						console.log(`[File Upload] 🔄 ${reason} for ${fileName}, retrying in ${backoffMs}ms`)
						await new Promise((resolve) => setTimeout(resolve, backoffMs))
						continue
					}

					// Log detailed error information before throwing
					logger.error(
						`[File Upload] ❌ Upload failed for ${fileName} (size: ${content.length} bytes, mimeType: ${mimeType}, attempt: ${attempt + 1}/${maxRetries})`,
						{
							error: error?.error || error?.message || 'Unknown error',
							status: error?.status,
							headers: error?.headers,
							success: error?.success,
						},
					)
					console.error(`[File Upload] ❌ Upload failed for ${fileName}:`, {
						error: error?.error || error?.message || 'Unknown error',
						status: error?.status,
						size: content.length,
						mimeType,
						attempt: attempt + 1,
					})
					throw error
				}
			}
			throw new Error(`Failed to upload ${fileName} after ${maxRetries} attempts`)
		}

		// Use sliding window concurrency for maximum throughput
		const CONCURRENCY_LIMIT = parseInt(process.env.UPLOAD_CONCURRENCY || '3', 10)
		const uploadedBlobs: Array<{
			result: FileUploadResult
			filePath: string
			sentMimeType: string
			returnedMimeType: string
			reused: boolean
		}> = []
		const failedFiles: Array<{
			name: string
			index: number
			error: string
			size: number
		}> = []

		// Track completed files count for accurate progress
		let completedFilesCount = 0

		// Process file with sliding window concurrency
		const processFile = async (file: UploadedFile, index: number) => {
			try {
				if (!file || !file.name) {
					throw new Error(`Undefined file at index ${index}`)
				}

				const fileCID = computeCID(file.content)
				const normalizedPath = file.name.replace(/^[^/]*\//, '')
				const existingBlob = existingBlobMap.get(normalizedPath) || existingBlobMap.get(file.name)

				if (existingBlob && existingBlob.cid === fileCID) {
					logger.info(`[File Upload] ♻️  Reused: ${file.name} (unchanged, CID: ${fileCID})`)
					const reusedCount = (getUploadJob(jobId)?.progress.filesReused || 0) + 1
					completedFilesCount++
					updateJobProgress(jobId, {
						filesReused: reusedCount,
						currentFile: `${completedFilesCount}/${validUploadedFiles.length}: ${file.name} (reused)`,
					})

					return {
						result: {
							hash: existingBlob.cid,
							blobRef: existingBlob.blobRef,
							...(file.compressed && {
								encoding: 'gzip' as const,
								mimeType: file.originalMimeType || file.mimeType,
							}),
							base64: !!file.base64Encoded,
						},
						filePath: file.name,
						sentMimeType: file.mimeType,
						returnedMimeType: existingBlob.blobRef.mimeType,
						reused: true,
					}
				}

				const uploadMimeType =
					file.compressed || file.mimeType.startsWith('text/html') ? 'application/octet-stream' : file.mimeType

				const compressionInfo = file.compressed ? ' (gzipped)' : ''
				const fileSizeMB = (file.size / 1024 / 1024).toFixed(2)
				logger.info(`[File Upload] ⬆️  Uploading: ${file.name} (${fileSizeMB}MB${compressionInfo})`)

				const uploadResult = await uploadBlobWithRetry(agent, file.content, uploadMimeType, file.name)

				const returnedBlobRef = uploadResult.data.blob
				const uploadedCount = (getUploadJob(jobId)?.progress.filesUploaded || 0) + 1
				completedFilesCount++
				updateJobProgress(jobId, {
					filesUploaded: uploadedCount,
					currentFile: `${completedFilesCount}/${validUploadedFiles.length}: ${file.name} (uploaded)`,
				})
				logger.info(`[File Upload] ✅ Uploaded: ${file.name} (CID: ${fileCID})`)

				return {
					result: {
						hash: returnedBlobRef.ref.toString(),
						blobRef: returnedBlobRef,
						...(file.compressed && {
							encoding: 'gzip' as const,
							mimeType: file.originalMimeType || file.mimeType,
						}),
						base64: !!file.base64Encoded,
					},
					filePath: file.name,
					sentMimeType: file.mimeType,
					returnedMimeType: returnedBlobRef.mimeType,
					reused: false,
				}
			} catch (uploadError) {
				const fileName = file?.name || 'unknown'
				const fileSize = file?.size || 0
				const errorMessage = uploadError instanceof Error ? uploadError.message : 'Unknown error'
				const errorDetails = {
					fileName,
					fileSize,
					index,
					error: errorMessage,
					stack: uploadError instanceof Error ? uploadError.stack : undefined,
				}
				logger.error(`Upload failed for file: ${fileName} (${fileSize} bytes) at index ${index}`, errorDetails)
				console.error(`Upload failed for file: ${fileName} (${fileSize} bytes) at index ${index}`, errorDetails)

				completedFilesCount++
				updateJobProgress(jobId, {
					currentFile: `${completedFilesCount}/${validUploadedFiles.length}: ${fileName} (failed)`,
				})

				// Track failed file but don't throw - continue with other files
				failedFiles.push({
					name: fileName,
					index,
					error: errorMessage,
					size: fileSize,
				})

				return null // Return null to indicate failure
			}
		}

		// Sliding window concurrency control
		const processWithConcurrency = async () => {
			const results: any[] = []
			let fileIndex = 0
			const executing = new Map<Promise<void>, { index: number; name: string }>()

			for (const file of validUploadedFiles) {
				const currentIndex = fileIndex++

				const promise = processFile(file, currentIndex)
					.then((result) => {
						results[currentIndex] = result
					})
					.catch((error) => {
						// This shouldn't happen since processFile catches errors, but just in case
						logger.error(`Unexpected error processing file at index ${currentIndex}`, error)
						results[currentIndex] = null
					})
					.finally(() => {
						executing.delete(promise)
					})

				executing.set(promise, { index: currentIndex, name: file.name })

				if (executing.size >= CONCURRENCY_LIMIT) {
					await Promise.race(executing.keys())
				}
			}

			// Wait for remaining uploads
			await Promise.all(executing.keys())
			console.log(`\n✅ Upload complete: ${completedFilesCount}/${validUploadedFiles.length} files processed\n`)
			return results.filter((r) => r !== undefined && r !== null) // Filter out null (failed) and undefined entries
		}

		const allResults = await processWithConcurrency()
		uploadedBlobs.push(...allResults)

		const currentReused = uploadedBlobs.filter((b) => b.reused).length
		const currentUploaded = uploadedBlobs.filter((b) => !b.reused).length
		const successfulCount = uploadedBlobs.length
		const failedCount = failedFiles.length

		logger.info(
			`[File Upload] 🎉 Upload complete → ${successfulCount}/${validUploadedFiles.length} files succeeded (${currentUploaded} uploaded, ${currentReused} reused), ${failedCount} failed`,
		)

		if (failedCount > 0) {
			logger.warn(`[File Upload] ⚠️  Failed files:`, failedFiles)
			console.warn(`[File Upload] ⚠️  ${failedCount} files failed to upload:`, failedFiles.map((f) => f.name).join(', '))
		}

		const reusedCount = uploadedBlobs.filter((b) => b.reused).length
		const uploadedCount = uploadedBlobs.filter((b) => !b.reused).length
		logger.info(
			`[File Upload] 🎉 Upload phase complete! Total: ${successfulCount} files (${uploadedCount} uploaded, ${reusedCount} reused)`,
		)

		// Build directory tree from blob results, split into subfs if needed, then put the manifest record.
		// Extracted so it can be retried with different blob sets (e.g. base64-encoded fallback).
		const buildManifestAndPut = async (blobs: typeof uploadedBlobs) => {
			const blobUploadResults: FileUploadResult[] = blobs.map((b) => b.result)
			const blobFilePaths: string[] = blobs.map((b) => b.filePath)

			console.log('Updating directory with blob references...')
			updateJobProgress(jobId, { phase: 'creating_manifest' })

			const successfulPaths = new Set(blobFilePaths.map((path) => path.replace(/^[^/]*\//, '')))
			const updatedDirectory = updateFileBlobs(directory, blobUploadResults, blobFilePaths, '', successfulPaths)
			const actualFileCount = blobs.length

			const MAX_MANIFEST_SIZE = 140 * 1024
			const FILE_COUNT_THRESHOLD = 250
			const TARGET_FILE_COUNT = 200
			const MAX_SUBFS_SIZE = 75 * 1024
			const subfsRecords: Array<{ uri: string; path: string }> = []
			let workingDirectory = updatedDirectory
			let currentFileCount = actualFileCount

			let manifest = createManifest(siteName, workingDirectory, actualFileCount)
			let manifestSize = JSON.stringify(manifest).length

			if (actualFileCount >= FILE_COUNT_THRESHOLD || manifestSize > MAX_MANIFEST_SIZE) {
				console.log(
					`⚠️  Large site detected (${actualFileCount} files, ${(manifestSize / 1024).toFixed(1)}KB), splitting into subfs records...`,
				)
				logger.info(`Large site with ${actualFileCount} files, splitting into subfs records`)

				let attempts = 0
				const MAX_ATTEMPTS = 100

				while ((manifestSize > MAX_MANIFEST_SIZE || currentFileCount > TARGET_FILE_COUNT) && attempts < MAX_ATTEMPTS) {
					attempts++

					const directories = findLargeDirectories(workingDirectory)
					directories.sort((a, b) => b.size - a.size)

					if (directories.length > 0) {
						const largestDir = directories[0]
						console.log(
							`  Split #${attempts}: ${largestDir.path} (${largestDir.fileCount} files, ${(largestDir.size / 1024).toFixed(1)}KB)`,
						)

						let subfsUri: string

						if (largestDir.size > MAX_SUBFS_SIZE) {
							console.log(
								`    → Directory too large (${(largestDir.size / 1024).toFixed(1)}KB), splitting into chunks...`,
							)
							const chunks = splitDirectoryIntoChunks(largestDir.directory, MAX_SUBFS_SIZE)
							console.log(`    → Created ${chunks.length} chunks`)

							const chunkUris: string[] = []
							for (let i = 0; i < chunks.length; i++) {
								const chunk = chunks[i]!
								const chunkRkey = TID.nextStr()
								const chunkFileCount = countFilesInDirectory(chunk)
								console.log(`    → Uploading chunk ${i + 1}/${chunks.length} (${chunkFileCount} files)...`)

								const chunkRecord = await agent.com.atproto.repo.putRecord({
									repo: did,
									collection: 'place.wisp.subfs',
									rkey: chunkRkey,
									record: {
										$type: 'place.wisp.subfs' as const,
										root: toSubfsDirectory(chunk),
										fileCount: chunkFileCount,
										createdAt: new Date().toISOString(),
									},
								})

								chunkUris.push(chunkRecord.data.uri)
							}

							console.log(`    → Creating parent subfs with ${chunkUris.length} chunk references...`)
							const parentDirectory: Directory = {
								$type: 'place.wisp.fs#directory' as const,
								type: 'directory' as const,
								entries: chunkUris.map((uri, i) => ({
									name: `chunk${i}`,
									node: {
										$type: 'place.wisp.fs#subfs' as const,
										type: 'subfs' as const,
										subject: uri,
										flat: true,
									},
								})),
							}

							const parentRkey = TID.nextStr()
							const parentRecord = await agent.com.atproto.repo.putRecord({
								repo: did,
								collection: 'place.wisp.subfs',
								rkey: parentRkey,
								record: {
									$type: 'place.wisp.subfs' as const,
									root: toSubfsDirectory(parentDirectory),
									fileCount: largestDir.fileCount,
									createdAt: new Date().toISOString(),
								},
							})

							subfsUri = parentRecord.data.uri
							console.log(`    ✓ Created parent subfs with ${chunks.length} chunks`)
							logger.info(`Created chunked subfs for ${largestDir.path}: ${subfsUri} (${chunks.length} chunks)`)
						} else {
							const subfsRkey = TID.nextStr()
							const subfsRecord = await agent.com.atproto.repo.putRecord({
								repo: did,
								collection: 'place.wisp.subfs',
								rkey: subfsRkey,
								record: {
									$type: 'place.wisp.subfs' as const,
									root: toSubfsDirectory(largestDir.directory),
									fileCount: largestDir.fileCount,
									createdAt: new Date().toISOString(),
								},
							})

							subfsUri = subfsRecord.data.uri
							console.log(`  ✅ Created subfs: ${subfsUri}`)
							logger.info(`Created subfs record for ${largestDir.path}: ${subfsUri}`)
						}

						subfsRecords.push({ uri: subfsUri, path: largestDir.path })
						workingDirectory = replaceDirectoryWithSubfs(workingDirectory, largestDir.path, subfsUri)
						currentFileCount -= largestDir.fileCount
					} else {
						const rootFiles = workingDirectory.entries.filter((e) => 'type' in e.node && e.node.type === 'file')

						if (rootFiles.length === 0) {
							throw new Error(
								`Cannot split manifest further - no files or directories available. ` +
									`Current: ${currentFileCount} files, ${(manifestSize / 1024).toFixed(1)}KB.`,
							)
						}

						const CHUNK_SIZE = 100
						const chunkFiles = rootFiles.slice(0, Math.min(CHUNK_SIZE, rootFiles.length))
						console.log(`  Split #${attempts}: flat root (${chunkFiles.length} files)`)

						const chunkDirectory: Directory = {
							$type: 'place.wisp.fs#directory' as const,
							type: 'directory' as const,
							entries: chunkFiles,
						}

						const subfsRkey = TID.nextStr()
						const subfsRecord = await agent.com.atproto.repo.putRecord({
							repo: did,
							collection: 'place.wisp.subfs',
							rkey: subfsRkey,
							record: {
								$type: 'place.wisp.subfs' as const,
								root: toSubfsDirectory(chunkDirectory),
								fileCount: chunkFiles.length,
								createdAt: new Date().toISOString(),
							},
						})

						const subfsUri = subfsRecord.data.uri
						console.log(`  ✅ Created flat subfs: ${subfsUri}`)
						logger.info(`Created flat subfs record with ${chunkFiles.length} files: ${subfsUri}`)

						const remainingEntries = workingDirectory.entries.filter(
							(e) => !chunkFiles.some((cf) => cf.name === e.name),
						)

						remainingEntries.push({
							name: `__subfs_${attempts}`,
							node: {
								$type: 'place.wisp.fs#subfs' as const,
								type: 'subfs' as const,
								subject: subfsUri,
								flat: true,
							},
						})

						workingDirectory = {
							$type: 'place.wisp.fs#directory' as const,
							type: 'directory' as const,
							entries: remainingEntries,
						}

						subfsRecords.push({ uri: subfsUri, path: `__subfs_${attempts}` })
						currentFileCount -= chunkFiles.length
					}

					manifest = createManifest(siteName, workingDirectory, currentFileCount)
					manifestSize = JSON.stringify(manifest).length
					const newSizeKB = (manifestSize / 1024).toFixed(1)
					console.log(
						`  → Manifest now ${newSizeKB}KB with ${currentFileCount} files (${subfsRecords.length} subfs total)`,
					)

					if (manifestSize <= MAX_MANIFEST_SIZE && currentFileCount <= TARGET_FILE_COUNT) {
						console.log(`  ✅ Manifest fits! (${currentFileCount} files, ${newSizeKB}KB)`)
						break
					}
				}

				if (manifestSize > MAX_MANIFEST_SIZE || currentFileCount > TARGET_FILE_COUNT) {
					throw new Error(
						`Failed to fit manifest after splitting ${attempts} directories. ` +
							`Current: ${currentFileCount} files, ${(manifestSize / 1024).toFixed(1)}KB. ` +
							`This should never happen - please report this issue.`,
					)
				}

				console.log(
					`✅ Split complete: ${subfsRecords.length} subfs records, ${currentFileCount} files in main, ${(manifestSize / 1024).toFixed(1)}KB manifest`,
				)
				logger.info(`Split into ${subfsRecords.length} subfs records, ${currentFileCount} files remaining in main tree`)
			} else {
				const manifestSizeKB = (manifestSize / 1024).toFixed(1)
				console.log(`Manifest created (${actualFileCount} files, ${manifestSizeKB}KB JSON) - no splitting needed`)
			}

			updateJobProgress(jobId, { phase: 'finalizing' })
			console.log('Putting record to PDS with rkey:', siteName)
			const record = await agent.com.atproto.repo.putRecord({
				repo: did,
				collection: 'place.wisp.fs',
				rkey: siteName,
				record: manifest,
			})
			console.log('Record successfully created on PDS:', record.data.uri)
			return record
		}

		// First attempt: no base64 encoding
		let record: Awaited<ReturnType<typeof agent.com.atproto.repo.putRecord>>
		try {
			record = await buildManifestAndPut(uploadedBlobs)
		} catch (err: any) {
			if (err?.status !== 500) throw err

			// On 500, retry with base64 encoding for compressed text files.
			// Re-read from the original File objects to avoid holding duplicate buffers in memory.
			logger.warn('Manifest put returned 500 — retrying with base64-encoded text files', err)
			console.warn('[Upload] Manifest put failed with 500, retrying with base64 encoding for text files...')

			const base64Blobs = [...uploadedBlobs]
			for (const uploadedFile of validUploadedFiles) {
				if (!uploadedFile.compressed || !isTextMimeType(uploadedFile.mimeType)) continue

				// Find the original File object to re-read content without holding extra buffers
				const originalFile = fileArray.find((f) => {
					if (!f) return false
					const wp = 'webkitRelativePath' in f ? String(f.webkitRelativePath) : ''
					return (wp || f.name) === uploadedFile.name
				})
				if (!originalFile) continue

				const originalContent = Buffer.from(await originalFile.arrayBuffer())
				const base64Content = Buffer.from(compressFile(originalContent).toString('base64'), 'binary')
				const uploadResult = await uploadBlobWithRetry(
					agent,
					base64Content,
					'application/octet-stream',
					uploadedFile.name,
				)
				const newBlobRef = uploadResult.data.blob

				const blobIdx = base64Blobs.findIndex((b) => b.filePath === uploadedFile.name)
				if (blobIdx !== -1) {
					base64Blobs[blobIdx] = {
						...base64Blobs[blobIdx]!,
						result: {
							hash: newBlobRef.ref.toString(),
							blobRef: newBlobRef,
							encoding: 'gzip',
							mimeType: uploadedFile.mimeType,
							base64: true,
						},
					}
				}
			}

			record = await buildManifestAndPut(base64Blobs)
		}

		if (publishStandardSiteRecords) {
			updateJobProgress(jobId, { phase: 'publishing_standard_site' })
			try {
				const siteUrl = buildWispSiteUrl(did, siteName)
				const blobReferences: UploadedBlobReference[] = uploadedBlobs.map((blob) => ({
					path: blob.filePath,
					blob: blob.result.blobRef,
					mimeType: blob.returnedMimeType,
					size: blob.result.blobRef.size,
				}))
				const successfulPaths = new Set(uploadedBlobs.map((blob) => stripUploadRoot(blob.filePath)))
				const successfulStandardSiteFiles = standardSiteFiles.filter((file) =>
					successfulPaths.has(stripUploadRoot(file.path)),
				)
				const detected = detectStandardSite({
					siteUrl,
					siteName,
					files: successfulStandardSiteFiles,
					blobReferences,
				})

				standardSiteSummary = {
					enabled: true,
					detected: detected.detected,
					posts: detected.posts.length,
					score: detected.score,
				}

				if (detected.detected) {
					const published = await publishStandardSite({
						agent: agent as unknown as RepoAgent,
						did,
						siteRkey: siteName,
						detection: detected,
					})

					standardSiteSummary = {
						...standardSiteSummary,
						publicationUri: published.publication.uri,
						documents: published.documents,
					}
					logger.info(
						`[StandardSite] Published ${published.documents.createdOrUpdated} documents for ${did}/${siteName}`,
					)
				}
			} catch (err) {
				const error = err instanceof Error ? err.message : 'Failed to publish standard.site records'
				standardSiteSummary = {
					enabled: true,
					detected: standardSiteSummary?.detected ?? false,
					posts: standardSiteSummary?.posts ?? 0,
					score: standardSiteSummary?.score,
					error,
				}
				logger.error(`[StandardSite] Failed to publish records for ${did}/${siteName}`, err)
			}
		}

		// Clean up old subfs records if we had any
		if (oldSubfsUris.length > 0) {
			console.log(`Cleaning up ${oldSubfsUris.length} old subfs records...`)
			logger.info(`Cleaning up ${oldSubfsUris.length} old subfs records`)

			// Delete old subfs records in parallel (don't wait for completion)
			Promise.all(
				oldSubfsUris.map(async ({ uri }) => {
					try {
						// Parse URI: at://did/collection/rkey
						const parts = uri.replace('at://', '').split('/')
						const subRkey = parts[2]

						await agent.com.atproto.repo.deleteRecord({
							repo: did,
							collection: 'place.wisp.subfs',
							rkey: subRkey,
						})

						console.log(`  🗑️  Deleted old subfs: ${uri}`)
						logger.info(`Deleted old subfs record: ${uri}`)
					} catch (err: any) {
						// Don't fail the whole upload if cleanup fails
						console.warn(`Failed to delete old subfs ${uri}:`, err?.message)
						logger.warn(`Failed to delete old subfs ${uri}`, err)
					}
				}),
			).catch((err) => {
				// Log but don't fail if cleanup fails
				logger.warn('Some subfs cleanup operations failed', err)
			})
		}

		completeUploadJob(jobId, {
			success: true,
			uri: record.data.uri,
			cid: record.data.cid,
			fileCount,
			siteName,
			skippedFiles,
			failedFiles,
			uploadedCount: validUploadedFiles.length - failedFiles.length,
			hasFailures: failedFiles.length > 0,
			standardSite: standardSiteSummary,
		})

		console.log('=== UPLOAD FILES COMPLETE ===')
	} catch (error) {
		console.error('=== UPLOAD ERROR ===')
		console.error('Error details:', error)
		logger.error('Upload error', error)
		failUploadJob(jobId, error instanceof Error ? error.message : 'Unknown error')
	}
}

export const wispRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/wisp',
		cookie: {
			secrets: cookieSecret,
			sign: ['did'],
		},
	})
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
		/**
		 * GET /wisp/upload-progress/:jobId
		 * SSE stream of upload progress events for the current user.
		 * 404: { error: 'Job not found' }
		 * 403: { error: 'Unauthorized' }
		 */
		.get('/upload-progress/:jobId', async ({ params: { jobId }, auth, set }) => {
			const job = getUploadJob(jobId)

			if (!job) {
				set.status = 404
				return { error: 'Job not found' }
			}

			// Verify job belongs to authenticated user
			if (job.did !== auth.did) {
				set.status = 403
				return { error: 'Unauthorized' }
			}

			// Set up SSE headers
			set.headers = {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			}

			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder()

					// Send initial state
					const sendEvent = (event: string, data: any) => {
						try {
							const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
							controller.enqueue(encoder.encode(message))
						} catch (_err) {
							// Controller closed, ignore
						}
					}

					// Send keepalive comment every 15 seconds to prevent timeout
					const keepaliveInterval = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(': keepalive\n\n'))
						} catch (_err) {
							// Controller closed, stop sending keepalives
							clearInterval(keepaliveInterval)
						}
					}, 15000)

					// Send current job state immediately
					sendEvent('progress', {
						status: job.status,
						progress: job.progress,
						result: job.result,
						error: job.error,
					})

					// If job is already completed or failed, close the stream
					if (job.status === 'completed' || job.status === 'failed') {
						clearInterval(keepaliveInterval)
						controller.close()
						return
					}

					// Listen for updates
					const cleanup = addJobListener(jobId, (event, data) => {
						sendEvent(event, data)

						// Close stream after done or error event
						if (event === 'done' || event === 'error') {
							clearInterval(keepaliveInterval)
							setTimeout(() => {
								try {
									controller.close()
								} catch (_err) {
									// Already closed
								}
							}, 100)
						}
					})

					// Cleanup on disconnect
					return () => {
						clearInterval(keepaliveInterval)
						cleanup()
					}
				},
			})

			return new Response(stream)
		})
		/**
		 * POST /wisp/upload-files
		 * Success (empty upload): { success: true, uri, cid, fileCount: 0, siteName }
		 * Success (async upload): { success: true, jobId, message }
		 * Failure: throws error with message "Failed to upload files: ..."
		 */
		.post('/upload-files', async ({ body, auth }) => {
			const {
				siteName,
				files,
				publishStandardSite: publishStandardSiteValue,
			} = body as {
				siteName: string
				files: File | File[]
				publishStandardSite?: string | boolean
			}
			const publishStandardSiteRecords = parseBooleanFormValue(publishStandardSiteValue)

			console.log('=== UPLOAD FILES START ===')
			console.log('Site name:', siteName)
			console.log('Files received:', Array.isArray(files) ? files.length : 'single file')

			try {
				if (!siteName) {
					throw new Error('Site name is required')
				}

				if (!isValidSiteName(siteName)) {
					throw new Error(
						'Invalid site name: must be 1-512 characters and contain only alphanumeric, dots, dashes, underscores, tildes, and colons',
					)
				}

				// Check if files were provided
				const hasFiles = files && (Array.isArray(files) ? files.length > 0 : !!files)

				if (!hasFiles) {
					// Handle empty upload synchronously (fast operation)
					const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))

					const emptyManifest = {
						$type: 'place.wisp.fs',
						site: siteName,
						root: {
							type: 'directory',
							entries: [],
						},
						fileCount: 0,
						createdAt: new Date().toISOString(),
					}

					// const validationResult = validateRecord(emptyManifest);
					// if (!validationResult.success) {
					//     throw new Error(`Invalid manifest: ${validationResult.error?.message || 'Validation failed'}`);
					// }

					const rkey = siteName

					const record = await agent.com.atproto.repo.putRecord({
						repo: auth.did,
						collection: 'place.wisp.fs',
						rkey: rkey,
						record: emptyManifest,
					})

					return {
						success: true,
						uri: record.data.uri,
						cid: record.data.cid,
						fileCount: 0,
						siteName,
					}
				}

				// For file uploads, create a job and process in background
				const fileArray = Array.isArray(files) ? files : [files]
				const jobId = createUploadJob(auth.did, siteName, fileArray.length)

				// Track upload speeds to estimate progress
				const uploadStats = {
					speeds: [] as number[], // MB/s from completed uploads
					getAverageSpeed(): number {
						if (this.speeds.length === 0) return 3 // Default 3 MB/s
						const sum = this.speeds.reduce((a, b) => a + b, 0)
						return sum / this.speeds.length
					},
				}

				// Create agent with OAuth session and upload progress monitoring
				const wrappedFetchHandler = async (url: string, init?: RequestInit) => {
					// Check if this is an uploadBlob request with a body
					if (url.includes('uploadBlob') && init?.body) {
						const originalBody = init.body
						const bodySize =
							originalBody instanceof Uint8Array
								? originalBody.length
								: originalBody instanceof ArrayBuffer
									? originalBody.byteLength
									: typeof originalBody === 'string'
										? new TextEncoder().encode(originalBody).length
										: 0

						const startTime = Date.now()

						if (bodySize > 10 * 1024 * 1024) {
							// Files over 10MB
							const sizeMB = (bodySize / 1024 / 1024).toFixed(1)
							const avgSpeed = uploadStats.getAverageSpeed()
							const estimatedDuration = bodySize / 1024 / 1024 / avgSpeed

							console.log(`[Upload Progress] Starting upload of ${sizeMB}MB file`)
							console.log(
								`[Upload Stats] Measured speeds from last ${uploadStats.speeds.length} files:`,
								uploadStats.speeds.map((s) => `${s.toFixed(2)} MB/s`).join(', '),
							)
							console.log(
								`[Upload Stats] Average speed: ${avgSpeed.toFixed(2)} MB/s, estimated duration: ${estimatedDuration.toFixed(0)}s`,
							)

							// Log estimated progress every 5 seconds
							const progressInterval = setInterval(() => {
								const elapsed = (Date.now() - startTime) / 1000
								const estimatedPercent = Math.min(95, Math.round((elapsed / estimatedDuration) * 100))
								const estimatedMB = Math.min(bodySize / 1024 / 1024, elapsed * avgSpeed).toFixed(1)
								console.log(
									`[Upload Progress] ~${estimatedPercent}% (~${estimatedMB}/${sizeMB}MB) - ${elapsed.toFixed(0)}s elapsed`,
								)
							}, 5000)

							try {
								const result = await auth.session.fetchHandler(url, init)
								clearInterval(progressInterval)
								const totalTime = (Date.now() - startTime) / 1000
								const actualSpeed = bodySize / 1024 / 1024 / totalTime
								uploadStats.speeds.push(actualSpeed)
								// Keep only last 10 uploads for rolling average
								if (uploadStats.speeds.length > 10) uploadStats.speeds.shift()
								console.log(
									`[Upload Progress] ✅ Completed ${sizeMB}MB in ${totalTime.toFixed(1)}s (${actualSpeed.toFixed(1)} MB/s)`,
								)
								return result
							} catch (err) {
								clearInterval(progressInterval)
								const elapsed = (Date.now() - startTime) / 1000
								console.error(`[Upload Progress] ❌ Upload failed after ${elapsed.toFixed(1)}s`)
								throw err
							}
						} else {
							const result = await auth.session.fetchHandler(url, init)
							const totalTime = (Date.now() - startTime) / 1000
							if (totalTime > 0.5) {
								// Only track if > 0.5s
								const actualSpeed = bodySize / 1024 / 1024 / totalTime
								uploadStats.speeds.push(actualSpeed)
								if (uploadStats.speeds.length > 10) uploadStats.speeds.shift()
								console.log(
									`[Upload Stats] Small file: ${(bodySize / 1024).toFixed(1)}KB in ${totalTime.toFixed(2)}s = ${actualSpeed.toFixed(2)} MB/s`,
								)
							}
							return result
						}
					}

					// Normal request
					return auth.session.fetchHandler(url, init)
				}

				const agent = new Agent(wrappedFetchHandler)
				console.log('Agent created for DID:', auth.did)
				console.log('Created upload job:', jobId)

				// Start background processing (don't await)
				processUploadInBackground(jobId, agent, auth.did, siteName, fileArray, publishStandardSiteRecords).catch(
					(err) => {
						console.error('Background upload process failed:', err)
						logger.error('Background upload process failed', err)
					},
				)

				// Return immediately with job ID
				return {
					success: true,
					jobId,
					message: `Upload started. Connect to /wisp/upload-progress/${jobId} for progress updates.`,
				}
			} catch (error) {
				console.error('=== UPLOAD ERROR ===')
				console.error('Error details:', error)
				logger.error('Upload error', error)
				throw new Error(`Failed to upload files: ${error instanceof Error ? error.message : 'Unknown error'}`)
			}
		})
