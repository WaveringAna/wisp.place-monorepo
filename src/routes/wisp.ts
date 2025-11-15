import { Elysia } from 'elysia'
import { requireAuth, type AuthenticatedContext } from '../lib/wisp-auth'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Agent } from '@atproto/api'
import { TID } from '@atproto/common-web'
import {
	type UploadedFile,
	type FileUploadResult,
	processUploadedFiles,
	createManifest,
	updateFileBlobs,
	shouldCompressFile,
	compressFile,
	computeCID,
	extractBlobMap,
	extractSubfsUris,
	findLargeDirectories,
	replaceDirectoryWithSubfs,
	estimateDirectorySize
} from '../lib/wisp-utils'
import { upsertSite } from '../lib/db'
import { logger } from '../lib/observability'
import { validateRecord } from '../lexicons/types/place/wisp/fs'
import { validateRecord as validateSubfsRecord } from '../lexicons/types/place/wisp/subfs'
import { MAX_SITE_SIZE, MAX_FILE_SIZE, MAX_FILE_COUNT } from '../lib/constants'
import {
	createUploadJob,
	getUploadJob,
	updateJobProgress,
	completeUploadJob,
	failUploadJob,
	addJobListener
} from '../lib/upload-jobs'

function isValidSiteName(siteName: string): boolean {
	if (!siteName || typeof siteName !== 'string') return false;

	// Length check (AT Protocol rkey limit)
	if (siteName.length < 1 || siteName.length > 512) return false;

	// Check for path traversal
	if (siteName === '.' || siteName === '..') return false;
	if (siteName.includes('/') || siteName.includes('\\')) return false;
	if (siteName.includes('\0')) return false;

	// AT Protocol rkey format: alphanumeric, dots, dashes, underscores, tildes, colons
	// Based on NSID format rules
	const validRkeyPattern = /^[a-zA-Z0-9._~:-]+$/;
	if (!validRkeyPattern.test(siteName)) return false;

	return true;
}

async function processUploadInBackground(
	jobId: string,
	agent: Agent,
	did: string,
	siteName: string,
	fileArray: File[]
): Promise<void> {
	try {
		// Try to fetch existing record to enable incremental updates
		let existingBlobMap = new Map<string, { blobRef: any; cid: string }>();
		let oldSubfsUris: Array<{ uri: string; path: string }> = [];
		console.log('Attempting to fetch existing record...');
		updateJobProgress(jobId, { phase: 'validating' });

		try {
			const rkey = siteName;
			const existingRecord = await agent.com.atproto.repo.getRecord({
				repo: did,
				collection: 'place.wisp.fs',
				rkey: rkey
			});
			console.log('Existing record found!');

			if (existingRecord.data.value && typeof existingRecord.data.value === 'object' && 'root' in existingRecord.data.value) {
				const manifest = existingRecord.data.value as any;

				// Extract blob map from main record
				existingBlobMap = extractBlobMap(manifest.root);
				console.log(`Found existing manifest with ${existingBlobMap.size} files in main record`);

				// Extract subfs URIs with their mount paths from main record
				const subfsUris = extractSubfsUris(manifest.root);
				oldSubfsUris = subfsUris; // Save for cleanup later

				if (subfsUris.length > 0) {
					console.log(`Found ${subfsUris.length} subfs records, fetching in parallel...`);
					logger.info(`Fetching ${subfsUris.length} subfs records for blob reuse`);

					// Fetch all subfs records in parallel
					const subfsRecords = await Promise.all(
						subfsUris.map(async ({ uri, path }) => {
							try {
								// Parse URI: at://did/collection/rkey
								const parts = uri.replace('at://', '').split('/');
								const subDid = parts[0];
								const collection = parts[1];
								const subRkey = parts[2];

								const record = await agent.com.atproto.repo.getRecord({
									repo: subDid,
									collection: collection,
									rkey: subRkey
								});

								return { record: record.data.value as any, mountPath: path };
							} catch (err: any) {
								logger.warn(`Failed to fetch subfs record ${uri}: ${err?.message}`, err);
								return null;
							}
						})
					);

					// Merge blob maps from all subfs records
					let totalSubfsBlobs = 0;
					for (const subfsData of subfsRecords) {
						if (subfsData && subfsData.record && 'root' in subfsData.record) {
							// Extract blobs with the correct mount path prefix
							const subfsMap = extractBlobMap(subfsData.record.root, subfsData.mountPath);
							subfsMap.forEach((value, key) => {
								existingBlobMap.set(key, value);
								totalSubfsBlobs++;
							});
						}
					}

					console.log(`Merged ${totalSubfsBlobs} files from ${subfsUris.length} subfs records`);
					logger.info(`Total blob map: ${existingBlobMap.size} files (main + subfs)`);
				}

				console.log(`Total existing blobs for reuse: ${existingBlobMap.size} files`);
				logger.info(`Found existing manifest with ${existingBlobMap.size} files for incremental update`);
			}
		} catch (error: any) {
			console.log('No existing record found or error:', error?.message || error);
			if (error?.status !== 400 && error?.error !== 'RecordNotFound') {
				logger.warn('Failed to fetch existing record, proceeding with full upload', error);
			}
		}

		// Convert File objects to UploadedFile format
		const uploadedFiles: UploadedFile[] = [];
		const skippedFiles: Array<{ name: string; reason: string }> = [];

		console.log('Processing files, count:', fileArray.length);
		updateJobProgress(jobId, { phase: 'compressing' });

		for (let i = 0; i < fileArray.length; i++) {
			const file = fileArray[i];

			// Skip undefined/null files
			if (!file || !file.name) {
				console.log(`Skipping undefined file at index ${i}`);
				skippedFiles.push({
					name: `[undefined file at index ${i}]`,
					reason: 'Invalid file object'
				});
				continue;
			}

			console.log(`Processing file ${i + 1}/${fileArray.length}:`, file.name, file.size, 'bytes');
			updateJobProgress(jobId, {
				filesProcessed: i + 1,
				currentFile: file.name
			});

			// Skip .git directory files
			const normalizedPath = file.name.replace(/^[^\/]*\//, '');
			if (normalizedPath.startsWith('.git/') || normalizedPath === '.git') {
				console.log(`Skipping .git file: ${file.name}`);
				skippedFiles.push({
					name: file.name,
					reason: '.git directory excluded'
				});
				continue;
			}

			// Skip files that are too large
			const maxSize = MAX_FILE_SIZE;
			if (file.size > maxSize) {
				skippedFiles.push({
					name: file.name,
					reason: `file too large (${(file.size / 1024 / 1024).toFixed(2)}MB, max 100MB)`
				});
				continue;
			}

			const arrayBuffer = await file.arrayBuffer();
			const originalContent = Buffer.from(arrayBuffer);
			const originalMimeType = file.type || 'application/octet-stream';

			// Determine if file should be compressed
			const shouldCompress = shouldCompressFile(originalMimeType);

			// Text files (HTML/CSS/JS) need base64 encoding to prevent PDS content sniffing
			// Audio files just need compression without base64
			const needsBase64 = originalMimeType.startsWith('text/') ||
				originalMimeType.includes('html') ||
				originalMimeType.includes('javascript') ||
				originalMimeType.includes('css') ||
				originalMimeType.includes('json') ||
				originalMimeType.includes('xml') ||
				originalMimeType.includes('svg');

			let finalContent: Buffer;
			let compressed = false;
			let base64Encoded = false;

			if (shouldCompress) {
				const compressedContent = compressFile(originalContent);
				compressed = true;

				if (needsBase64) {
					// Text files: compress AND base64 encode
					finalContent = Buffer.from(compressedContent.toString('base64'), 'binary');
					base64Encoded = true;
					const compressionRatio = (compressedContent.length / originalContent.length * 100).toFixed(1);
					console.log(`Compressing+base64 ${file.name}: ${originalContent.length} -> ${compressedContent.length} bytes (${compressionRatio}%), base64: ${finalContent.length} bytes`);
					logger.info(`Compressing+base64 ${file.name}: ${originalContent.length} -> ${compressedContent.length} bytes (${compressionRatio}%), base64: ${finalContent.length} bytes`);
				} else {
					// Audio files: just compress, no base64
					finalContent = compressedContent;
					const compressionRatio = (compressedContent.length / originalContent.length * 100).toFixed(1);
					console.log(`Compressing ${file.name}: ${originalContent.length} -> ${compressedContent.length} bytes (${compressionRatio}%)`);
					logger.info(`Compressing ${file.name}: ${originalContent.length} -> ${compressedContent.length} bytes (${compressionRatio}%)`);
				}
			} else {
				// Binary files: upload directly
				finalContent = originalContent;
				console.log(`Uploading ${file.name} directly: ${originalContent.length} bytes (no compression)`);
				logger.info(`Uploading ${file.name} directly: ${originalContent.length} bytes (binary)`);
			}

			uploadedFiles.push({
				name: file.name,
				content: finalContent,
				mimeType: originalMimeType,
				size: finalContent.length,
				compressed,
				base64Encoded,
				originalMimeType
			});
		}

		// Update total file count after filtering (important for progress tracking)
		updateJobProgress(jobId, {
			totalFiles: uploadedFiles.length
		});

		// Check total size limit
		const totalSize = uploadedFiles.reduce((sum, file) => sum + file.size, 0);
		const maxTotalSize = MAX_SITE_SIZE;

		if (totalSize > maxTotalSize) {
			throw new Error(`Total upload size ${(totalSize / 1024 / 1024).toFixed(2)}MB exceeds 300MB limit`);
		}

		// Check file count limit
		if (uploadedFiles.length > MAX_FILE_COUNT) {
			throw new Error(`File count ${uploadedFiles.length} exceeds ${MAX_FILE_COUNT} files limit`);
		}

		console.log(`After filtering: ${uploadedFiles.length} files to process (${skippedFiles.length} skipped)`);

		if (uploadedFiles.length === 0) {
			// Create empty manifest
			const emptyManifest = {
				$type: 'place.wisp.fs',
				site: siteName,
				root: {
					type: 'directory',
					entries: []
				},
				fileCount: 0,
				createdAt: new Date().toISOString()
			};

			const validationResult = validateRecord(emptyManifest);
			if (!validationResult.success) {
				throw new Error(`Invalid manifest: ${validationResult.error?.message || 'Validation failed'}`);
			}

			const rkey = siteName;
			updateJobProgress(jobId, { phase: 'finalizing' });

			const record = await agent.com.atproto.repo.putRecord({
				repo: did,
				collection: 'place.wisp.fs',
				rkey: rkey,
				record: emptyManifest
			});

			await upsertSite(did, rkey, siteName);

			completeUploadJob(jobId, {
				success: true,
				uri: record.data.uri,
				cid: record.data.cid,
				fileCount: 0,
				siteName,
				skippedFiles
			});
			return;
		}

		// Process files into directory structure
		console.log('Processing uploaded files into directory structure...');
		const validUploadedFiles = uploadedFiles.filter((f, i) => {
			if (!f || !f.name || !f.content) {
				console.error(`Filtering out invalid file at index ${i}`);
				return false;
			}
			return true;
		});

		const { directory, fileCount } = processUploadedFiles(validUploadedFiles);
		console.log('Directory structure created, file count:', fileCount);

		// Upload files as blobs with retry logic for DPoP nonce conflicts
		console.log('Starting blob upload/reuse phase...');
		updateJobProgress(jobId, { phase: 'uploading' });

		// Helper function to upload blob with exponential backoff retry and timeout
		const uploadBlobWithRetry = async (
			agent: Agent,
			content: Buffer,
			mimeType: string,
			fileName: string,
			maxRetries = 5
		) => {
			for (let attempt = 0; attempt < maxRetries; attempt++) {
				try {
					console.log(`[File Upload] Starting upload attempt ${attempt + 1}/${maxRetries} for ${fileName} (${content.length} bytes, ${mimeType})`);

					// Add timeout wrapper to prevent hanging requests
					const uploadPromise = agent.com.atproto.repo.uploadBlob(content, { encoding: mimeType });
					const timeoutMs = 300000; // 5 minute timeout per upload

					const timeoutPromise = new Promise((_, reject) => {
						setTimeout(() => reject(new Error('Upload timeout')), timeoutMs);
					});

					const result = await Promise.race([uploadPromise, timeoutPromise]) as any;
					console.log(`[File Upload] ✅ Successfully uploaded ${fileName} on attempt ${attempt + 1}`);
					return result;
				} catch (error: any) {
					const isDPoPNonceError =
						error?.message?.toLowerCase().includes('nonce') ||
						error?.message?.toLowerCase().includes('dpop') ||
						error?.status === 409;

					const isTimeout = error?.message === 'Upload timeout';
					const isRateLimited = error?.status === 429 || error?.message?.toLowerCase().includes('rate');

					// Retry on DPoP nonce conflicts, timeouts, or rate limits
					if ((isDPoPNonceError || isTimeout || isRateLimited) && attempt < maxRetries - 1) {
						let backoffMs: number;
						if (isRateLimited) {
							backoffMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s, 16s for rate limits
						} else if (isTimeout) {
							backoffMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s for timeouts
						} else {
							backoffMs = 100 * Math.pow(2, attempt); // 100ms, 200ms, 400ms for DPoP
						}

						const reason = isDPoPNonceError ? 'DPoP nonce conflict' : isTimeout ? 'timeout' : 'rate limit';
						logger.info(`[File Upload] 🔄 ${reason} for ${fileName}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`);
						console.log(`[File Upload] 🔄 ${reason} for ${fileName}, retrying in ${backoffMs}ms`);
						await new Promise(resolve => setTimeout(resolve, backoffMs));
						continue;
					}

					// Log detailed error information before throwing
					logger.error(`[File Upload] ❌ Upload failed for ${fileName} (size: ${content.length} bytes, mimeType: ${mimeType}, attempt: ${attempt + 1}/${maxRetries})`, {
						error: error?.error || error?.message || 'Unknown error',
						status: error?.status,
						headers: error?.headers,
						success: error?.success
					});
					console.error(`[File Upload] ❌ Upload failed for ${fileName}:`, {
						error: error?.error || error?.message || 'Unknown error',
						status: error?.status,
						size: content.length,
						mimeType,
						attempt: attempt + 1
					});
					throw error;
				}
			}
			throw new Error(`Failed to upload ${fileName} after ${maxRetries} attempts`);
		};

		// Use sliding window concurrency for maximum throughput
		const CONCURRENCY_LIMIT = 20; // Maximum concurrent uploads
		const uploadedBlobs: Array<{
			result: FileUploadResult;
			filePath: string;
			sentMimeType: string;
			returnedMimeType: string;
			reused: boolean;
		}> = [];
		const failedFiles: Array<{
			name: string;
			index: number;
			error: string;
			size: number;
		}> = [];

		// Process file with sliding window concurrency
		const processFile = async (file: UploadedFile, index: number) => {
			try {
				if (!file || !file.name) {
					throw new Error(`Undefined file at index ${index}`);
				}

				const fileCID = computeCID(file.content);
				const normalizedPath = file.name.replace(/^[^\/]*\//, '');
				const existingBlob = existingBlobMap.get(normalizedPath) || existingBlobMap.get(file.name);

				if (existingBlob && existingBlob.cid === fileCID) {
					logger.info(`[File Upload] ♻️  Reused: ${file.name} (unchanged, CID: ${fileCID})`);
					updateJobProgress(jobId, {
						filesReused: (getUploadJob(jobId)?.progress.filesReused || 0) + 1
					});

					return {
						result: {
							hash: existingBlob.cid,
							blobRef: existingBlob.blobRef,
							...(file.compressed && {
								encoding: 'gzip' as const,
								mimeType: file.originalMimeType || file.mimeType,
								base64: file.base64Encoded || false
							})
						},
						filePath: file.name,
						sentMimeType: file.mimeType,
						returnedMimeType: existingBlob.blobRef.mimeType,
						reused: true
					};
				}

				const uploadMimeType = file.compressed || file.mimeType.startsWith('text/html')
					? 'application/octet-stream'
					: file.mimeType;

				const compressionInfo = file.compressed ? ' (gzipped)' : '';
				const fileSizeMB = (file.size / 1024 / 1024).toFixed(2);
				logger.info(`[File Upload] ⬆️  Uploading: ${file.name} (${fileSizeMB}MB${compressionInfo})`);

				const uploadResult = await uploadBlobWithRetry(
					agent,
					file.content,
					uploadMimeType,
					file.name
				);

				const returnedBlobRef = uploadResult.data.blob;
				updateJobProgress(jobId, {
					filesUploaded: (getUploadJob(jobId)?.progress.filesUploaded || 0) + 1
				});
				logger.info(`[File Upload] ✅ Uploaded: ${file.name} (CID: ${fileCID})`);

				return {
					result: {
						hash: returnedBlobRef.ref.toString(),
						blobRef: returnedBlobRef,
						...(file.compressed && {
							encoding: 'gzip' as const,
							mimeType: file.originalMimeType || file.mimeType,
							base64: file.base64Encoded || false
						})
					},
					filePath: file.name,
					sentMimeType: file.mimeType,
					returnedMimeType: returnedBlobRef.mimeType,
					reused: false
				};
			} catch (uploadError) {
				const fileName = file?.name || 'unknown';
				const fileSize = file?.size || 0;
				const errorMessage = uploadError instanceof Error ? uploadError.message : 'Unknown error';
				const errorDetails = {
					fileName,
					fileSize,
					index,
					error: errorMessage,
					stack: uploadError instanceof Error ? uploadError.stack : undefined
				};
				logger.error(`Upload failed for file: ${fileName} (${fileSize} bytes) at index ${index}`, errorDetails);
				console.error(`Upload failed for file: ${fileName} (${fileSize} bytes) at index ${index}`, errorDetails);

				// Track failed file but don't throw - continue with other files
				failedFiles.push({
					name: fileName,
					index,
					error: errorMessage,
					size: fileSize
				});

				return null; // Return null to indicate failure
			}
		};

		// Sliding window concurrency control
		const processWithConcurrency = async () => {
			const results: any[] = [];
			let fileIndex = 0;
			const executing = new Map<Promise<void>, { index: number; name: string }>();

			for (const file of validUploadedFiles) {
				const currentIndex = fileIndex++;

				const promise = processFile(file, currentIndex)
					.then(result => {
						results[currentIndex] = result;
						console.log(`[Concurrency] File ${currentIndex} (${file.name}) completed successfully`);
					})
					.catch(error => {
						// This shouldn't happen since processFile catches errors, but just in case
						logger.error(`Unexpected error processing file at index ${currentIndex}`, error);
						console.error(`[Concurrency] File ${currentIndex} (${file.name}) had unexpected error:`, error);
						results[currentIndex] = null;
					})
					.finally(() => {
						executing.delete(promise);
						const remaining = Array.from(executing.values()).map(f => `${f.index}:${f.name}`);
						console.log(`[Concurrency] File ${currentIndex} (${file.name}) removed. Remaining ${executing.size}: [${remaining.join(', ')}]`);
					});

				executing.set(promise, { index: currentIndex, name: file.name });
				const current = Array.from(executing.values()).map(f => `${f.index}:${f.name}`);
				console.log(`[Concurrency] Added file ${currentIndex} (${file.name}). Total ${executing.size}: [${current.join(', ')}]`);

				if (executing.size >= CONCURRENCY_LIMIT) {
					console.log(`[Concurrency] Hit limit (${CONCURRENCY_LIMIT}), waiting for one to complete...`);
					await Promise.race(executing.keys());
					console.log(`[Concurrency] One completed, continuing. Remaining: ${executing.size}`);
				}
			}

			// Wait for remaining uploads
			const remaining = Array.from(executing.values()).map(f => `${f.index}:${f.name}`);
			console.log(`[Concurrency] Waiting for ${executing.size} remaining uploads: [${remaining.join(', ')}]`);
			await Promise.all(executing.keys());
			console.log(`[Concurrency] All uploads complete!`);
			return results.filter(r => r !== undefined && r !== null); // Filter out null (failed) and undefined entries
		};

		const allResults = await processWithConcurrency();
		uploadedBlobs.push(...allResults);

		const currentReused = uploadedBlobs.filter(b => b.reused).length;
		const currentUploaded = uploadedBlobs.filter(b => !b.reused).length;
		const successfulCount = uploadedBlobs.length;
		const failedCount = failedFiles.length;

		logger.info(`[File Upload] 🎉 Upload complete → ${successfulCount}/${validUploadedFiles.length} files succeeded (${currentUploaded} uploaded, ${currentReused} reused), ${failedCount} failed`);

		if (failedCount > 0) {
			logger.warn(`[File Upload] ⚠️  Failed files:`, failedFiles);
			console.warn(`[File Upload] ⚠️  ${failedCount} files failed to upload:`, failedFiles.map(f => f.name).join(', '));
		}

		const reusedCount = uploadedBlobs.filter(b => b.reused).length;
		const uploadedCount = uploadedBlobs.filter(b => !b.reused).length;
		logger.info(`[File Upload] 🎉 Upload phase complete! Total: ${successfulCount} files (${uploadedCount} uploaded, ${reusedCount} reused)`);

		const uploadResults: FileUploadResult[] = uploadedBlobs.map(blob => blob.result);
		const filePaths: string[] = uploadedBlobs.map(blob => blob.filePath);

		// Update directory with file blobs
		console.log('Updating directory with blob references...');
		updateJobProgress(jobId, { phase: 'creating_manifest' });
		const updatedDirectory = updateFileBlobs(directory, uploadResults, filePaths);

		// Check if we need to split into subfs records
		// Split proactively if we have lots of files to avoid hitting manifest size limits
		const MAX_MANIFEST_SIZE = 140 * 1024; // 140KB to be safe (PDS limit is 150KB)
		const FILE_COUNT_THRESHOLD = 250; // Start splitting early
		const subfsRecords: Array<{ uri: string; path: string }> = [];
		let workingDirectory = updatedDirectory;
		let currentFileCount = fileCount;

		// Create initial manifest to check size
		let manifest = createManifest(siteName, workingDirectory, fileCount);
		let manifestSize = JSON.stringify(manifest).length;

		// Split if we have lots of files OR if manifest is already too large
		if (fileCount >= FILE_COUNT_THRESHOLD || manifestSize > MAX_MANIFEST_SIZE) {
			console.log(`⚠️  Large site detected (${fileCount} files, ${(manifestSize / 1024).toFixed(1)}KB), splitting into subfs records...`);
			logger.info(`Large site with ${fileCount} files, splitting into subfs records`);

			// Keep splitting until manifest fits under limit
			let attempts = 0;
			const MAX_ATTEMPTS = 100; // Allow many splits for very large sites

			while (manifestSize > MAX_MANIFEST_SIZE && attempts < MAX_ATTEMPTS) {
				attempts++;

				// Find all directories sorted by size (largest first)
				const directories = findLargeDirectories(workingDirectory);
				directories.sort((a, b) => b.size - a.size);

				if (directories.length === 0) {
					// No more directories to split - this should be very rare
					throw new Error(
						`Cannot split manifest further - no subdirectories available. ` +
						`Current size: ${(manifestSize / 1024).toFixed(1)}KB. ` +
						`Try organizing files into subdirectories.`
					);
				}

				// Pick the largest directory
				const largestDir = directories[0];
				console.log(`  Split #${attempts}: ${largestDir.path} (${largestDir.fileCount} files, ${(largestDir.size / 1024).toFixed(1)}KB)`);

				// Create a subfs record for this directory
				const subfsRkey = TID.nextStr();
				const subfsManifest = {
					$type: 'place.wisp.subfs' as const,
					root: largestDir.directory,
					fileCount: largestDir.fileCount,
					createdAt: new Date().toISOString()
				};

				// Validate subfs record
				const subfsValidation = validateSubfsRecord(subfsManifest);
				if (!subfsValidation.success) {
					throw new Error(`Invalid subfs manifest: ${subfsValidation.error?.message || 'Validation failed'}`);
				}

				// Upload subfs record to PDS
				const subfsRecord = await agent.com.atproto.repo.putRecord({
					repo: did,
					collection: 'place.wisp.subfs',
					rkey: subfsRkey,
					record: subfsManifest
				});

				const subfsUri = subfsRecord.data.uri;
				subfsRecords.push({ uri: subfsUri, path: largestDir.path });
				console.log(`  ✅ Created subfs: ${subfsUri}`);
				logger.info(`Created subfs record for ${largestDir.path}: ${subfsUri}`);

				// Replace directory with subfs node in the main tree
				workingDirectory = replaceDirectoryWithSubfs(workingDirectory, largestDir.path, subfsUri);

				// Recreate manifest and check new size
				currentFileCount -= largestDir.fileCount;
				manifest = createManifest(siteName, workingDirectory, fileCount);
				manifestSize = JSON.stringify(manifest).length;
				const newSizeKB = (manifestSize / 1024).toFixed(1);
				console.log(`  → Manifest now ${newSizeKB}KB with ${currentFileCount} files (${subfsRecords.length} subfs total)`);

				// Check if we're under the limit now
				if (manifestSize <= MAX_MANIFEST_SIZE) {
					console.log(`  ✅ Manifest fits! (${newSizeKB}KB < 140KB)`);
					break;
				}
			}

			if (manifestSize > MAX_MANIFEST_SIZE) {
				throw new Error(
					`Failed to fit manifest after splitting ${attempts} directories. ` +
					`Current size: ${(manifestSize / 1024).toFixed(1)}KB. ` +
					`This should never happen - please report this issue.`
				);
			}

			console.log(`✅ Split complete: ${subfsRecords.length} subfs records, ${currentFileCount} files in main, ${(manifestSize / 1024).toFixed(1)}KB manifest`);
			logger.info(`Split into ${subfsRecords.length} subfs records, ${currentFileCount} files remaining in main tree`);
		} else {
			const manifestSizeKB = (manifestSize / 1024).toFixed(1);
			console.log(`Manifest created (${fileCount} files, ${manifestSizeKB}KB JSON) - no splitting needed`);
		}

		const rkey = siteName;
		updateJobProgress(jobId, { phase: 'finalizing' });

		console.log('Putting record to PDS with rkey:', rkey);
		const record = await agent.com.atproto.repo.putRecord({
			repo: did,
			collection: 'place.wisp.fs',
			rkey: rkey,
			record: manifest
		});
		console.log('Record successfully created on PDS:', record.data.uri);

		// Store site in database cache
		await upsertSite(did, rkey, siteName);

		// Clean up old subfs records if we had any
		if (oldSubfsUris.length > 0) {
			console.log(`Cleaning up ${oldSubfsUris.length} old subfs records...`);
			logger.info(`Cleaning up ${oldSubfsUris.length} old subfs records`);

			// Delete old subfs records in parallel (don't wait for completion)
			Promise.all(
				oldSubfsUris.map(async ({ uri }) => {
					try {
						// Parse URI: at://did/collection/rkey
						const parts = uri.replace('at://', '').split('/');
						const subRkey = parts[2];

						await agent.com.atproto.repo.deleteRecord({
							repo: did,
							collection: 'place.wisp.subfs',
							rkey: subRkey
						});

						console.log(`  🗑️  Deleted old subfs: ${uri}`);
						logger.info(`Deleted old subfs record: ${uri}`);
					} catch (err: any) {
						// Don't fail the whole upload if cleanup fails
						console.warn(`Failed to delete old subfs ${uri}:`, err?.message);
						logger.warn(`Failed to delete old subfs ${uri}`, err);
					}
				})
			).catch(err => {
				// Log but don't fail if cleanup fails
				logger.warn('Some subfs cleanup operations failed', err);
			});
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
			hasFailures: failedFiles.length > 0
		});

		console.log('=== UPLOAD FILES COMPLETE ===');
	} catch (error) {
		console.error('=== UPLOAD ERROR ===');
		console.error('Error details:', error);
		logger.error('Upload error', error);
		failUploadJob(jobId, error instanceof Error ? error.message : 'Unknown error');
	}
}

export const wispRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({
		prefix: '/wisp',
		cookie: {
			secrets: cookieSecret,
			sign: ['did']
		}
	})
		.derive(async ({ cookie }) => {
			const auth = await requireAuth(client, cookie)
			return { auth }
		})
		.get(
			'/upload-progress/:jobId',
			async ({ params: { jobId }, auth, set }) => {
				const job = getUploadJob(jobId);

				if (!job) {
					set.status = 404;
					return { error: 'Job not found' };
				}

				// Verify job belongs to authenticated user
				if (job.did !== auth.did) {
					set.status = 403;
					return { error: 'Unauthorized' };
				}

				// Set up SSE headers
				set.headers = {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'Connection': 'keep-alive'
				};

				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();

						// Send initial state
						const sendEvent = (event: string, data: any) => {
							try {
								const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
								controller.enqueue(encoder.encode(message));
							} catch (err) {
								// Controller closed, ignore
							}
						};

						// Send keepalive comment every 15 seconds to prevent timeout
						const keepaliveInterval = setInterval(() => {
							try {
								controller.enqueue(encoder.encode(': keepalive\n\n'));
							} catch (err) {
								// Controller closed, stop sending keepalives
								clearInterval(keepaliveInterval);
							}
						}, 15000);

						// Send current job state immediately
						sendEvent('progress', {
							status: job.status,
							progress: job.progress,
							result: job.result,
							error: job.error
						});

						// If job is already completed or failed, close the stream
						if (job.status === 'completed' || job.status === 'failed') {
							clearInterval(keepaliveInterval);
							controller.close();
							return;
						}

						// Listen for updates
						const cleanup = addJobListener(jobId, (event, data) => {
							sendEvent(event, data);

							// Close stream after done or error event
							if (event === 'done' || event === 'error') {
								clearInterval(keepaliveInterval);
								setTimeout(() => {
									try {
										controller.close();
									} catch (err) {
										// Already closed
									}
								}, 100);
							}
						});

						// Cleanup on disconnect
						return () => {
							clearInterval(keepaliveInterval);
							cleanup();
						};
					}
				});

				return new Response(stream);
			}
		)
		.post(
			'/upload-files',
			async ({ body, auth }) => {
				const { siteName, files } = body as {
					siteName: string;
					files: File | File[]
				};

				console.log('=== UPLOAD FILES START ===');
				console.log('Site name:', siteName);
				console.log('Files received:', Array.isArray(files) ? files.length : 'single file');

				try {
					if (!siteName) {
						throw new Error('Site name is required')
					}

					if (!isValidSiteName(siteName)) {
						throw new Error('Invalid site name: must be 1-512 characters and contain only alphanumeric, dots, dashes, underscores, tildes, and colons')
					}

					// Check if files were provided
					const hasFiles = files && (Array.isArray(files) ? files.length > 0 : !!files);

					if (!hasFiles) {
						// Handle empty upload synchronously (fast operation)
						const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))

						const emptyManifest = {
							$type: 'place.wisp.fs',
							site: siteName,
							root: {
								type: 'directory',
								entries: []
							},
							fileCount: 0,
							createdAt: new Date().toISOString()
						};

						const validationResult = validateRecord(emptyManifest);
						if (!validationResult.success) {
							throw new Error(`Invalid manifest: ${validationResult.error?.message || 'Validation failed'}`);
						}

						const rkey = siteName;

						const record = await agent.com.atproto.repo.putRecord({
							repo: auth.did,
							collection: 'place.wisp.fs',
							rkey: rkey,
							record: emptyManifest
						});

						await upsertSite(auth.did, rkey, siteName);

						return {
							success: true,
							uri: record.data.uri,
							cid: record.data.cid,
							fileCount: 0,
							siteName
						};
					}

					// For file uploads, create a job and process in background
					const fileArray = Array.isArray(files) ? files : [files];
					const jobId = createUploadJob(auth.did, siteName, fileArray.length);

					// Create agent with OAuth session
					const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
					console.log('Agent created for DID:', auth.did);
					console.log('Created upload job:', jobId);

					// Start background processing (don't await)
					processUploadInBackground(jobId, agent, auth.did, siteName, fileArray).catch(err => {
						console.error('Background upload process failed:', err);
						logger.error('Background upload process failed', err);
					});

					// Return immediately with job ID
					return {
						success: true,
						jobId,
						message: 'Upload started. Connect to /wisp/upload-progress/' + jobId + ' for progress updates.'
					};
				} catch (error) {
					console.error('=== UPLOAD ERROR ===');
					console.error('Error details:', error);
					logger.error('Upload error', error);
					throw new Error(`Failed to upload files: ${error instanceof Error ? error.message : 'Unknown error'}`);
				}
			}
		)
