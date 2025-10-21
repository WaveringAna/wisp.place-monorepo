import type { BlobRef } from "@atproto/api";
import type { Record, Directory, File, Entry } from "../lexicon/types/place/wisp/fs";

export interface UploadedFile {
	name: string;
	content: Buffer;
	mimeType: string;
	size: number;
}

export interface FileUploadResult {
	hash: string;
	blobRef: BlobRef;
}

export interface ProcessedDirectory {
	directory: Directory;
	fileCount: number;
}

/**
 * Process uploaded files into a directory structure
 */
export function processUploadedFiles(files: UploadedFile[]): ProcessedDirectory {
	console.log(`🏗️  Processing ${files.length} uploaded files`);
	const entries: Entry[] = [];
	let fileCount = 0;

	// Group files by directory
	const directoryMap = new Map<string, UploadedFile[]>();

	for (const file of files) {
		// Remove any base folder name from the path
		const normalizedPath = file.name.replace(/^[^\/]*\//, '');
		const parts = normalizedPath.split('/');

		console.log(`📄 Processing file: ${file.name} -> normalized: ${normalizedPath}`);

		if (parts.length === 1) {
			// Root level file
			console.log(`📁 Root level file: ${parts[0]}`);
			entries.push({
				name: parts[0],
				node: {
					$type: 'place.wisp.fs#file' as const,
					type: 'file' as const,
					blob: undefined as any // Will be filled after upload
				}
			});
			fileCount++;
		} else {
			// File in subdirectory
			const dirPath = parts.slice(0, -1).join('/');
			console.log(`📂 Subdirectory file: ${dirPath}/${parts[parts.length - 1]}`);
			if (!directoryMap.has(dirPath)) {
				directoryMap.set(dirPath, []);
				console.log(`➕ Created directory: ${dirPath}`);
			}
			directoryMap.get(dirPath)!.push({
				...file,
				name: normalizedPath
			});
		}
	}

	// Process subdirectories
	console.log(`📂 Processing ${directoryMap.size} subdirectories`);
	for (const [dirPath, dirFiles] of directoryMap) {
		console.log(`📁 Processing directory: ${dirPath} with ${dirFiles.length} files`);
		const dirEntries: Entry[] = [];

		for (const file of dirFiles) {
			const fileName = file.name.split('/').pop()!;
			console.log(`  📄 Adding file to directory: ${fileName}`);
			dirEntries.push({
				name: fileName,
				node: {
					$type: 'place.wisp.fs#file' as const,
					type: 'file' as const,
					blob: undefined as any // Will be filled after upload
				}
			});
			fileCount++;
		}

		// Build nested directory structure
		const pathParts = dirPath.split('/');
		let currentEntries = entries;

		console.log(`🏗️  Building nested structure for path: ${pathParts.join('/')}`);

		for (let i = 0; i < pathParts.length; i++) {
			const part = pathParts[i];
			const isLast = i === pathParts.length - 1;

			let existingEntry = currentEntries.find(e => e.name === part);

			if (!existingEntry) {
				const newDir = {
					$type: 'place.wisp.fs#directory' as const,
					type: 'directory' as const,
					entries: isLast ? dirEntries : []
				};

				existingEntry = {
					name: part,
					node: newDir
				};
				currentEntries.push(existingEntry);
				console.log(`  ➕ Created directory entry: ${part}`);
			} else if ('entries' in existingEntry.node && isLast) {
				(existingEntry.node as any).entries.push(...dirEntries);
				console.log(`  📝 Added files to existing directory: ${part}`);
			}

			if (existingEntry && 'entries' in existingEntry.node) {
				currentEntries = (existingEntry.node as any).entries;
			}
		}
	}

	console.log(`✅ Directory structure completed with ${fileCount} total files`);

	const result = {
		directory: {
			$type: 'place.wisp.fs#directory' as const,
			type: 'directory' as const,
			entries
		},
		fileCount
	};

	console.log('📋 Final directory structure:', JSON.stringify(result, null, 2));
	return result;
}

/**
 * Create the manifest record for a site
 */
export function createManifest(
	siteName: string,
	root: Directory,
	fileCount: number
): Record {
	const manifest: Record = {
		$type: 'place.wisp.fs' as const,
		site: siteName,
		root,
		fileCount,
		createdAt: new Date().toISOString()
	};

	console.log(`📋 Created manifest for site "${siteName}" with ${fileCount} files`);
	console.log('📄 Manifest structure:', JSON.stringify(manifest, null, 2));

	return manifest;
}

/**
 * Update file blobs in directory structure after upload
 */
export function updateFileBlobs(
	directory: Directory,
	uploadResults: FileUploadResult[],
	filePaths: string[]
): Directory {
	console.log(`🔄 Updating file blobs: ${uploadResults.length} results for ${filePaths.length} paths`);

	const updatedEntries = directory.entries.map(entry => {
		if ('type' in entry.node && entry.node.type === 'file') {
			const fileIndex = filePaths.findIndex(path => path.endsWith(entry.name));
			if (fileIndex !== -1 && uploadResults[fileIndex]) {
				console.log(`  🔗 Updating blob for file: ${entry.name} -> ${uploadResults[fileIndex].hash}`);
				return {
					...entry,
					node: {
						$type: 'place.wisp.fs#file' as const,
						type: 'file' as const,
						blob: uploadResults[fileIndex].blobRef
					}
				};
			} else {
				console.warn(`  ⚠️  Could not find upload result for file: ${entry.name}`);
			}
		} else if ('type' in entry.node && entry.node.type === 'directory') {
			console.log(`  📂 Recursively updating directory: ${entry.name}`);
			return {
				...entry,
				node: updateFileBlobs(entry.node as Directory, uploadResults, filePaths)
			};
		}
		return entry;
	}) as Entry[];

	const result = {
		$type: 'place.wisp.fs#directory' as const,
		type: 'directory' as const,
		entries: updatedEntries
	};

	console.log('✅ File blobs updated');
	return result;
}
