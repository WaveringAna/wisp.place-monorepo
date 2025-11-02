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
	compressFile
} from '../lib/wisp-utils'
import { upsertSite } from '../lib/db'
import { logger } from '../lib/observability'
import { validateRecord } from '../lexicon/types/place/wisp/fs'
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

export const wispRoutes = (client: NodeOAuthClient) =>
	new Elysia({ prefix: '/wisp' })
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

					// Convert File objects to UploadedFile format
					// Elysia gives us File objects directly, handle both single file and array
					const fileArray = Array.isArray(files) ? files : [files];
					const uploadedFiles: UploadedFile[] = [];
					const skippedFiles: Array<{ name: string; reason: string }> = [];



					for (let i = 0; i < fileArray.length; i++) {
						const file = fileArray[i];

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
						const base64Content = Buffer.from(compressedContent.toString('base64'), 'utf-8');
						const compressionRatio = (compressedContent.length / originalContent.length * 100).toFixed(1);
						logger.info(`Compressing ${file.name}: ${originalContent.length} -> ${compressedContent.length} bytes (${compressionRatio}%), base64: ${base64Content.length} bytes`);

						uploadedFiles.push({
							name: file.name,
							content: base64Content,
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
					const { directory, fileCount } = processUploadedFiles(uploadedFiles);

					// Upload files as blobs in parallel
					// For compressed files, we upload as octet-stream and store the original MIME type in metadata
					// For text/html files, we also use octet-stream as a workaround for PDS image pipeline issues
					const uploadPromises = uploadedFiles.map(async (file, i) => {
						try {
							// If compressed, always upload as octet-stream
							// Otherwise, workaround: PDS incorrectly processes text/html through image pipeline
							const uploadMimeType = file.compressed || file.mimeType.startsWith('text/html')
								? 'application/octet-stream'
								: file.mimeType;

							const compressionInfo = file.compressed ? ' (gzipped)' : '';
							logger.info(`[File Upload] Uploading file: ${file.name} (original: ${file.mimeType}, sending as: ${uploadMimeType}, ${file.size} bytes${compressionInfo})`);

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
								returnedMimeType: returnedBlobRef.mimeType
							};
						} catch (uploadError) {
							logger.error('Upload failed for file', uploadError);
							throw uploadError;
						}
					});

					// Wait for all uploads to complete
					const uploadedBlobs = await Promise.all(uploadPromises);

					// Extract results and file paths in correct order
					const uploadResults: FileUploadResult[] = uploadedBlobs.map(blob => blob.result);
					const filePaths: string[] = uploadedBlobs.map(blob => blob.filePath);

					// Update directory with file blobs
					const updatedDirectory = updateFileBlobs(directory, uploadResults, filePaths);

					// Create manifest
					const manifest = createManifest(siteName, updatedDirectory, fileCount);

					// Use site name as rkey
					const rkey = siteName;

					let record;
					try {
						record = await agent.com.atproto.repo.putRecord({
							repo: auth.did,
							collection: 'place.wisp.fs',
							rkey: rkey,
							record: manifest
						});
					} catch (putRecordError: any) {
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
						uploadedCount: uploadedFiles.length
					};

					return result;
				} catch (error) {
					logger.error('Upload error', error, {
						message: error instanceof Error ? error.message : 'Unknown error',
						name: error instanceof Error ? error.name : undefined
					});
					throw new Error(`Failed to upload files: ${error instanceof Error ? error.message : 'Unknown error'}`);
				}
			}
		)
