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

				console.log('🚀 Starting upload process', { siteName, fileCount: Array.isArray(files) ? files.length : 1 });

				try {
					if (!siteName) {
						console.error('❌ Site name is required');
						throw new Error('Site name is required')
					}

					console.log('✅ Initial validation passed');

					// Check if files were provided
					const hasFiles = files && (Array.isArray(files) ? files.length > 0 : !!files);

					if (!hasFiles) {
						console.log('📝 Creating empty site (no files provided)');

						// Create agent with OAuth session
						console.log('🔐 Creating agent with OAuth session');
						const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
						console.log('✅ Agent created successfully');

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

						// Use site name as rkey
						const rkey = siteName;

						// Create the record with explicit rkey
						console.log(`📝 Creating empty site record in repo with rkey: ${rkey}`);
						const record = await agent.com.atproto.repo.putRecord({
							repo: auth.did,
							collection: 'place.wisp.fs',
							rkey: rkey,
							record: emptyManifest
						});

						console.log('✅ Empty site record created successfully:', {
							uri: record.data.uri,
							cid: record.data.cid
						});

						// Store site in database cache
						console.log('💾 Storing site in database cache');
						await upsertSite(auth.did, rkey, siteName);
						console.log('✅ Site stored in database');

						return {
							success: true,
							uri: record.data.uri,
							cid: record.data.cid,
							fileCount: 0,
							siteName
						};
					}

					// Create agent with OAuth session
					console.log('🔐 Creating agent with OAuth session');
					const agent = new Agent((url, init) => auth.session.fetchHandler(url, init))
					console.log('✅ Agent created successfully');

					// Convert File objects to UploadedFile format
					// Elysia gives us File objects directly, handle both single file and array
					const fileArray = Array.isArray(files) ? files : [files];
					console.log(`📁 Processing ${fileArray.length} files`);
					const uploadedFiles: UploadedFile[] = [];

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
						
						console.log(`📄 Processing file ${i + 1}/${fileArray.length}: ${file.name} (${file.size} bytes, ${file.type})`);
						
						// Skip excluded files
						if (excludedFiles.has(fileExtension)) {
							console.log(`⏭️  Skipping excluded file: ${file.name}`);
							continue;
						}
						
						// Skip files that aren't in allowed extensions
						if (!allowedExtensions.has(fileExtension)) {
							console.log(`⏭️  Skipping non-web file: ${file.name} (${fileExtension})`);
							continue;
						}
						
						// Skip files that are too large (limit to 100MB per file)
						const maxSize = 100 * 1024 * 1024; // 100MB
						if (file.size > maxSize) {
							console.log(`⏭️  Skipping large file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)}MB > 100MB limit)`);
							continue;
						}
						
						console.log(`✅ Including file: ${file.name}`);
						const arrayBuffer = await file.arrayBuffer();
						uploadedFiles.push({
							name: file.name,
							content: Buffer.from(arrayBuffer),
							mimeType: file.type || 'application/octet-stream',
							size: file.size
						});
					}

					// Check total size limit (300MB)
					const totalSize = uploadedFiles.reduce((sum, file) => sum + file.size, 0);
					const maxTotalSize = 300 * 1024 * 1024; // 300MB
					
					console.log(`📊 Filtered to ${uploadedFiles.length} files from ${fileArray.length} total files`);
					console.log(`📦 Total size: ${(totalSize / 1024 / 1024).toFixed(2)}MB (limit: 300MB)`);

					if (totalSize > maxTotalSize) {
						throw new Error(`Total upload size ${(totalSize / 1024 / 1024).toFixed(2)}MB exceeds 300MB limit`);
					}

					if (uploadedFiles.length === 0) {
						console.log('⚠️  No valid web files found, creating empty site instead');

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

						// Use site name as rkey
						const rkey = siteName;

						// Create the record with explicit rkey
						console.log(`📝 Creating empty site record in repo with rkey: ${rkey}`);
						const record = await agent.com.atproto.repo.putRecord({
							repo: auth.did,
							collection: 'place.wisp.fs',
							rkey: rkey,
							record: emptyManifest
						});

						console.log('✅ Empty site record created successfully:', {
							uri: record.data.uri,
							cid: record.data.cid
						});

						// Store site in database cache
						console.log('💾 Storing site in database cache');
						await upsertSite(auth.did, rkey, siteName);
						console.log('✅ Site stored in database');

						return {
							success: true,
							uri: record.data.uri,
							cid: record.data.cid,
							fileCount: 0,
							siteName,
							message: 'Site created but no valid web files were found to upload'
						};
					}

					console.log('✅ File conversion completed');

					// Process files into directory structure
					console.log('🏗️  Building directory structure');
					const { directory, fileCount } = processUploadedFiles(uploadedFiles);
					console.log(`✅ Directory structure created with ${fileCount} files`);

					// Upload files as blobs
					const uploadResults: FileUploadResult[] = [];
					const filePaths: string[] = [];

					console.log('⬆️  Starting blob upload process');
					for (let i = 0; i < uploadedFiles.length; i++) {
						const file = uploadedFiles[i];
						console.log(`📤 Uploading blob ${i + 1}/${uploadedFiles.length}: ${file.name}`);
						
						try {
							console.log(`🔍 Upload details:`, {
								fileName: file.name,
								fileSize: file.size,
								mimeType: file.mimeType,
								contentLength: file.content.length
							});

							const uploadResult = await agent.com.atproto.repo.uploadBlob(
								file.content,
								{
									encoding: file.mimeType
								}
							);

							console.log(`✅ Upload successful for ${file.name}:`, {
								hash: uploadResult.data.blob.ref.toString(),
								mimeType: uploadResult.data.blob.mimeType,
								size: uploadResult.data.blob.size
							});

							uploadResults.push({
								hash: uploadResult.data.blob.ref.toString(),
								blobRef: uploadResult.data.blob
							});

							filePaths.push(file.name);
						} catch (uploadError) {
							console.error(`❌ Upload failed for file ${file.name}:`, uploadError);
							console.error('Upload error details:', {
								fileName: file.name,
								fileSize: file.size,
								mimeType: file.mimeType,
								error: uploadError
							});
							throw uploadError;
						}
					}

					console.log('✅ All blobs uploaded successfully');

					// Update directory with file blobs
					console.log('🔄 Updating file blobs in directory structure');
					const updatedDirectory = updateFileBlobs(directory, uploadResults, filePaths);
					console.log('✅ File blobs updated');

					// Create manifest
					console.log('📋 Creating manifest');
					const manifest = createManifest(siteName, updatedDirectory, fileCount);
					console.log('✅ Manifest created');

					// Use site name as rkey
					const rkey = siteName;

					// Create the record with explicit rkey
					console.log(`📝 Creating record in repo with rkey: ${rkey}`);
					const record = await agent.com.atproto.repo.putRecord({
						repo: auth.did,
						collection: 'place.wisp.fs',
						rkey: rkey,
						record: manifest
					});

					console.log('✅ Record created successfully:', {
						uri: record.data.uri,
						cid: record.data.cid
					});

					// Store site in database cache
					console.log('💾 Storing site in database cache');
					await upsertSite(auth.did, rkey, siteName);
					console.log('✅ Site stored in database');

					const result = {
						success: true,
						uri: record.data.uri,
						cid: record.data.cid,
						fileCount,
						siteName
					};

					console.log('🎉 Upload process completed successfully');
					return result;
				} catch (error) {
					console.error('❌ Upload error:', error);
					console.error('Error details:', {
						message: error instanceof Error ? error.message : 'Unknown error',
						stack: error instanceof Error ? error.stack : undefined,
						name: error instanceof Error ? error.name : undefined
					});
					throw new Error(`Failed to upload files: ${error instanceof Error ? error.message : 'Unknown error'}`);
				}
			}
		)