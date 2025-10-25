import { Elysia } from 'elysia'
import { requireAuth, type AuthenticatedContext } from '../lib/wisp-auth'
import { NodeOAuthClient } from '@atproto/oauth-client-node'
import { Agent } from '@atproto/api'
import {
	type UploadedFile,
	type FileUploadResult,
	processUploadedFiles,
	createManifest,
	updateFileBlobs
} from '../lib/wisp-utils'
import { upsertSite } from '../lib/db'
import { logger } from '../lib/logger'
import { validateRecord } from '../lexicon/types/place/wisp/fs'

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

					// Define allowed file extensions for static site hosting
					const allowedExtensions = new Set([
						// HTML
						'.html', '.htm',
						// CSS
						'.css',
						// JavaScript
						'.js', '.mjs', '.jsx', '.ts', '.tsx',
						// Images
						'.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico', '.avif',
						// Fonts
						'.woff', '.woff2', '.ttf', '.otf', '.eot',
						// Documents
						'.pdf', '.txt',
						// JSON (for config files, but not .map files)
						'.json',
						// Audio/Video
						'.mp3', '.mp4', '.webm', '.ogg', '.wav',
						// Other web assets
						'.xml', '.rss', '.atom'
					]);

					// Files to explicitly exclude
					const excludedFiles = new Set([
						'.map', '.DS_Store', 'Thumbs.db'
					]);

					for (let i = 0; i < fileArray.length; i++) {
						const file = fileArray[i];
						const fileExtension = '.' + file.name.split('.').pop()?.toLowerCase();

						// Skip excluded files
						if (excludedFiles.has(fileExtension)) {
							skippedFiles.push({ name: file.name, reason: 'excluded file type' });
							continue;
						}

						// Skip files that aren't in allowed extensions
						if (!allowedExtensions.has(fileExtension)) {
							skippedFiles.push({ name: file.name, reason: 'unsupported file type' });
							continue;
						}

						// Skip files that are too large (limit to 100MB per file)
						const maxSize = 100 * 1024 * 1024; // 100MB
						if (file.size > maxSize) {
							skippedFiles.push({
								name: file.name,
								reason: `file too large (${(file.size / 1024 / 1024).toFixed(2)}MB, max 100MB)`
							});
							continue;
						}

						const arrayBuffer = await file.arrayBuffer();
						uploadedFiles.push({
							name: file.name,
							content: Buffer.from(arrayBuffer),
							mimeType: 'application/octet-stream',
							size: file.size
						});
					}

					// Check total size limit (300MB)
					const totalSize = uploadedFiles.reduce((sum, file) => sum + file.size, 0);
					const maxTotalSize = 300 * 1024 * 1024; // 300MB

					if (totalSize > maxTotalSize) {
						throw new Error(`Total upload size ${(totalSize / 1024 / 1024).toFixed(2)}MB exceeds 300MB limit`);
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

					// Upload files as blobs in parallel (always as octet-stream)
					const uploadPromises = uploadedFiles.map(async (file, i) => {
						try {
							const uploadResult = await agent.com.atproto.repo.uploadBlob(
								file.content,
								{
									encoding: 'application/octet-stream'
								}
							);

							const sentMimeType = file.mimeType;
							const returnedBlobRef = uploadResult.data.blob;

							// Use the blob ref exactly as returned from PDS
							return {
								result: {
									hash: returnedBlobRef.ref.toString(),
									blobRef: returnedBlobRef
								},
								filePath: file.name,
								sentMimeType,
								returnedMimeType: returnedBlobRef.mimeType
							};
						} catch (uploadError) {
							logger.error('[Wisp] Upload failed for file', uploadError);
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
						logger.error('[Wisp] Failed to create record on PDS');
						logger.error('[Wisp] Record creation error', putRecordError);

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
					logger.error('[Wisp] Upload error', error);
					logger.errorWithContext('[Wisp] Upload error details', {
						message: error instanceof Error ? error.message : 'Unknown error',
						name: error instanceof Error ? error.name : undefined
					}, error);
					throw new Error(`Failed to upload files: ${error instanceof Error ? error.message : 'Unknown error'}`);
				}
			}
		)
