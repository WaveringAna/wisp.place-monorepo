import { Elysia } from 'elysia'
import { requireAuth, type AuthenticatedContext } from '../lib/wisp-auth'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Agent } from '@atproto/api'
import {
	type UploadedFile,
	type FileUploadResult,
	processUploadedFiles,
	createManifest,
	updateFileBlobs,
	shouldCompressFile,
	compressFile,
	computeCID,
	extractBlobMap
} from '../lib/wisp-utils'
import { upsertSite } from '../lib/db'
import { logger } from '../lib/observability'
import { validateRecord } from '../lexicons/types/place/wisp/fs'
import { MAX_SITE_SIZE, MAX_FILE_SIZE, MAX_FILE_COUNT } from '../lib/constants'

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
						// Create agent with OAuth session
						const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))

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

						// Validate the manifest
						const validationResult = validateRecord(emptyManifest);
						if (!validationResult.success) {
							throw new Error(`Invalid manifest: ${validationResult.error?.message || 'Validation failed'}`);
						}

						// Use site name as rkey
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

					// Create agent with OAuth session
					const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
					console.log('Agent created for DID:', auth.did);

					// Try to fetch existing record to enable incremental updates
					let existingBlobMap = new Map<string, { blobRef: any; cid: string }>();
					console.log('Attempting to fetch existing record...');
					try {
						const rkey = siteName;
						const existingRecord = await agent.com.atproto.repo.getRecord({
							repo: auth.did,
							collection: 'place.wisp.fs',
							rkey: rkey
						});
						console.log('Existing record found!');

						if (existingRecord.data.value && typeof existingRecord.data.value === 'object' && 'root' in existingRecord.data.value) {
							const manifest = existingRecord.data.value as any;
							existingBlobMap = extractBlobMap(manifest.root);
							console.log(`Found existing manifest with ${existingBlobMap.size} files for incremental update`);
							logger.info(`Found existing manifest with ${existingBlobMap.size} files for incremental update`);
						}
					} catch (error: any) {
						console.log('No existing record found or error:', error?.message || error);
						// Record doesn't exist yet, this is a new site
						if (error?.status !== 400 && error?.error !== 'RecordNotFound') {
							logger.warn('Failed to fetch existing record, proceeding with full upload', error);
						}
					}

					// Convert File objects to UploadedFile format
					// Elysia gives us File objects directly, handle both single file and array
					const fileArray = Array.isArray(files) ? files : [files];
					const uploadedFiles: UploadedFile[] = [];
					const skippedFiles: Array<{ name: string; reason: string }> = [];

					console.log('Processing files, count:', fileArray.length);

					for (let i = 0; i < fileArray.length; i++) {
						const file = fileArray[i];
						console.log(`Processing file ${i + 1}/${fileArray.length}:`, file.name, file.size, 'bytes');

						// Skip files that are too large (limit to 100MB per file)
						const maxSize = MAX_FILE_SIZE; // 100MB
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

						// Compress and base64 encode ALL files
						const compressedContent = compressFile(originalContent);
						// Base64 encode the gzipped content to prevent PDS content sniffing
						// Convert base64 string to bytes using binary encoding (each char becomes exactly one byte)
						// This is what PDS receives and computes CID on
						const base64Content = Buffer.from(compressedContent.toString('base64'), 'binary');
						const compressionRatio = (compressedContent.length / originalContent.length * 100).toFixed(1);
						console.log(`Compressing ${file.name}: ${originalContent.length} -> ${compressedContent.length} bytes (${compressionRatio}%), base64: ${base64Content.length} bytes`);
						logger.info(`Compressing ${file.name}: ${originalContent.length} -> ${compressedContent.length} bytes (${compressionRatio}%), base64: ${base64Content.length} bytes`);

						uploadedFiles.push({
							name: file.name,
							content: base64Content, // This is the gzipped+base64 content that will be uploaded and CID-computed
							mimeType: originalMimeType,
							size: base64Content.length,
							compressed: true,
							originalMimeType
						});
					}

					// Check total size limit (300MB)
					const totalSize = uploadedFiles.reduce((sum, file) => sum + file.size, 0);
					const maxTotalSize = MAX_SITE_SIZE; // 300MB

					if (totalSize > maxTotalSize) {
						throw new Error(`Total upload size ${(totalSize / 1024 / 1024).toFixed(2)}MB exceeds 300MB limit`);
					}

					// Check file count limit (2000 files)
					if (uploadedFiles.length > MAX_FILE_COUNT) {
						throw new Error(`File count ${uploadedFiles.length} exceeds ${MAX_FILE_COUNT} files limit`);
					}

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

						// Validate the manifest
						const validationResult = validateRecord(emptyManifest);
						if (!validationResult.success) {
							throw new Error(`Invalid manifest: ${validationResult.error?.message || 'Validation failed'}`);
						}

						// Use site name as rkey
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
							siteName,
							skippedFiles,
							message: 'Site created but no valid web files were found to upload'
						};
					}

					// Process files into directory structure
					console.log('Processing uploaded files into directory structure...');
					console.log('uploadedFiles array length:', uploadedFiles.length);
					console.log('uploadedFiles contents:', uploadedFiles.map((f, i) => `${i}: ${f?.name || 'UNDEFINED'}`));

					// Filter out any undefined/null/invalid entries (defensive)
					const validUploadedFiles = uploadedFiles.filter((f, i) => {
						if (!f) {
							console.error(`Filtering out undefined/null file at index ${i}`);
							return false;
						}
						if (!f.name) {
							console.error(`Filtering out file with no name at index ${i}:`, f);
							return false;
						}
						if (!f.content) {
							console.error(`Filtering out file with no content at index ${i}:`, f.name);
							return false;
						}
						return true;
					});
					if (validUploadedFiles.length !== uploadedFiles.length) {
						console.warn(`Filtered out ${uploadedFiles.length - validUploadedFiles.length} invalid files`);
					}
					console.log('validUploadedFiles length:', validUploadedFiles.length);

					const { directory, fileCount } = processUploadedFiles(validUploadedFiles);
					console.log('Directory structure created, file count:', fileCount);

					// Upload files as blobs in parallel (or reuse existing blobs with matching CIDs)
					console.log('Starting blob upload/reuse phase...');
					// For compressed files, we upload as octet-stream and store the original MIME type in metadata
					// For text/html files, we also use octet-stream as a workaround for PDS image pipeline issues
					const uploadPromises = validUploadedFiles.map(async (file, i) => {
						try {
							// Skip undefined files (shouldn't happen after filter, but defensive)
							if (!file || !file.name) {
								console.error(`ERROR: Undefined file at index ${i} in validUploadedFiles!`);
								throw new Error(`Undefined file at index ${i}`);
							}

							// Compute CID for this file to check if it already exists
							// Note: file.content is already gzipped+base64 encoded
							const fileCID = computeCID(file.content);

							// Normalize the file path for comparison (remove base folder prefix like "cobblemon/")
							const normalizedPath = file.name.replace(/^[^\/]*\//, '');

							// Check if we have an existing blob with the same CID
							// Try both the normalized path and the full path
							const existingBlob = existingBlobMap.get(normalizedPath) || existingBlobMap.get(file.name);

							if (existingBlob && existingBlob.cid === fileCID) {
								// Reuse existing blob - no need to upload
								logger.info(`[File Upload] Reusing existing blob for: ${file.name} (CID: ${fileCID})`);

								return {
									result: {
										hash: existingBlob.cid,
										blobRef: existingBlob.blobRef,
										...(file.compressed && {
											encoding: 'gzip' as const,
											mimeType: file.originalMimeType || file.mimeType,
											base64: true
										})
									},
									filePath: file.name,
									sentMimeType: file.mimeType,
									returnedMimeType: existingBlob.blobRef.mimeType,
									reused: true
								};
							}

							// File is new or changed - upload it
							// If compressed, always upload as octet-stream
							// Otherwise, workaround: PDS incorrectly processes text/html through image pipeline
							const uploadMimeType = file.compressed || file.mimeType.startsWith('text/html')
								? 'application/octet-stream'
								: file.mimeType;

							const compressionInfo = file.compressed ? ' (gzipped)' : '';
							logger.info(`[File Upload] Uploading new/changed file: ${file.name} (original: ${file.mimeType}, sending as: ${uploadMimeType}, ${file.size} bytes${compressionInfo}, CID: ${fileCID})`);

							const uploadResult = await agent.com.atproto.repo.uploadBlob(
								file.content,
								{
									encoding: uploadMimeType
								}
							);

							const returnedBlobRef = uploadResult.data.blob;

							// Use the blob ref exactly as returned from PDS
							return {
								result: {
									hash: returnedBlobRef.ref.toString(),
									blobRef: returnedBlobRef,
									...(file.compressed && {
										encoding: 'gzip' as const,
										mimeType: file.originalMimeType || file.mimeType,
										base64: true
									})
								},
								filePath: file.name,
								sentMimeType: file.mimeType,
								returnedMimeType: returnedBlobRef.mimeType,
								reused: false
							};
						} catch (uploadError) {
							logger.error('Upload failed for file', uploadError);
							throw uploadError;
						}
					});

					// Wait for all uploads to complete
					const uploadedBlobs = await Promise.all(uploadPromises);

					// Count reused vs uploaded blobs
					const reusedCount = uploadedBlobs.filter(b => (b as any).reused).length;
					const uploadedCount = uploadedBlobs.filter(b => !(b as any).reused).length;
					console.log(`Blob statistics: ${reusedCount} reused, ${uploadedCount} uploaded, ${uploadedBlobs.length} total`);
					logger.info(`Blob statistics: ${reusedCount} reused, ${uploadedCount} uploaded, ${uploadedBlobs.length} total`);

					// Extract results and file paths in correct order
					const uploadResults: FileUploadResult[] = uploadedBlobs.map(blob => blob.result);
					const filePaths: string[] = uploadedBlobs.map(blob => blob.filePath);

					// Update directory with file blobs
					console.log('Updating directory with blob references...');
					const updatedDirectory = updateFileBlobs(directory, uploadResults, filePaths);

					// Create manifest
					console.log('Creating manifest...');
					const manifest = createManifest(siteName, updatedDirectory, fileCount);
					console.log('Manifest created successfully');

					// Use site name as rkey
					const rkey = siteName;

					let record;
					try {
						console.log('Putting record to PDS with rkey:', rkey);
						record = await agent.com.atproto.repo.putRecord({
							repo: auth.did,
							collection: 'place.wisp.fs',
							rkey: rkey,
							record: manifest
						});
						console.log('Record successfully created on PDS:', record.data.uri);
					} catch (putRecordError: any) {
						console.error('FAILED to create record on PDS:', putRecordError);
						logger.error('Failed to create record on PDS', putRecordError);

						throw putRecordError;
					}

					// Store site in database cache
					await upsertSite(auth.did, rkey, siteName);

					const result = {
						success: true,
						uri: record.data.uri,
						cid: record.data.cid,
						fileCount,
						siteName,
						skippedFiles,
						uploadedCount: validUploadedFiles.length
					};

					console.log('=== UPLOAD FILES COMPLETE ===');
					return result;
				} catch (error) {
					console.error('=== UPLOAD ERROR ===');
					console.error('Error details:', error);
					console.error('Stack trace:', error instanceof Error ? error.stack : 'N/A');
					logger.error('Upload error', error, {
						message: error instanceof Error ? error.message : 'Unknown error',
						name: error instanceof Error ? error.name : undefined
					});
					throw new Error(`Failed to upload files: ${error instanceof Error ? error.message : 'Unknown error'}`);
				}
			}
		)
