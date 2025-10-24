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
	const entries: Entry[] = [];
	let fileCount = 0;

	// Group files by directory
	const directoryMap = new Map<string, UploadedFile[]>();

	for (const file of files) {
		// Remove any base folder name from the path
		const normalizedPath = file.name.replace(/^[^\/]*\//, '');
		const parts = normalizedPath.split('/');

		if (parts.length === 1) {
			// Root level file
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
			if (!directoryMap.has(dirPath)) {
				directoryMap.set(dirPath, []);
			}
			directoryMap.get(dirPath)!.push({
				...file,
				name: normalizedPath
			});
		}
	}

	// Process subdirectories
	for (const [dirPath, dirFiles] of directoryMap) {
		const dirEntries: Entry[] = [];

		for (const file of dirFiles) {
			const fileName = file.name.split('/').pop()!;
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
			} else if ('entries' in existingEntry.node && isLast) {
				(existingEntry.node as any).entries.push(...dirEntries);
			}

			if (existingEntry && 'entries' in existingEntry.node) {
				currentEntries = (existingEntry.node as any).entries;
			}
		}
	}

	const result = {
		directory: {
			$type: 'place.wisp.fs#directory' as const,
			type: 'directory' as const,
			entries
		},
		fileCount
	};

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
	return {
		$type: 'place.wisp.fs' as const,
		site: siteName,
		root,
		fileCount,
		createdAt: new Date().toISOString()
	};
}

/**
 * Update file blobs in directory structure after upload
 * Uses path-based matching to correctly match files in nested directories
 */
export function updateFileBlobs(
	directory: Directory,
	uploadResults: FileUploadResult[],
	filePaths: string[],
	currentPath: string = ''
): Directory {
	const mimeTypeMismatches: string[] = [];

	const updatedEntries = directory.entries.map(entry => {
		if ('type' in entry.node && entry.node.type === 'file') {
			// Build the full path for this file
			const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

			// Find exact match in filePaths (need to handle normalized paths)
			const fileIndex = filePaths.findIndex((path) => {
				// Normalize both paths by removing leading base folder
				const normalizedUploadPath = path.replace(/^[^\/]*\//, '');
				const normalizedEntryPath = fullPath;
				return normalizedUploadPath === normalizedEntryPath || path === fullPath;
			});

			if (fileIndex !== -1 && uploadResults[fileIndex]) {
				const blobRef = uploadResults[fileIndex].blobRef;
				const uploadedPath = filePaths[fileIndex];

				// Check if MIME types make sense for this file extension
				const expectedMime = getExpectedMimeType(entry.name);
				if (expectedMime && blobRef.mimeType !== expectedMime && !blobRef.mimeType.startsWith(expectedMime)) {
					mimeTypeMismatches.push(`${fullPath}: expected ${expectedMime}, got ${blobRef.mimeType} (from upload: ${uploadedPath})`);
				}

				return {
					...entry,
					node: {
						$type: 'place.wisp.fs#file' as const,
						type: 'file' as const,
						blob: blobRef
					}
				};
			} else {
				console.error(`❌ BLOB MATCHING ERROR: Could not find blob for file: ${fullPath}`);
				console.error(`   Available paths:`, filePaths.slice(0, 10), filePaths.length > 10 ? `... and ${filePaths.length - 10} more` : '');
			}
		} else if ('type' in entry.node && entry.node.type === 'directory') {
			const dirPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
			return {
				...entry,
				node: updateFileBlobs(entry.node as Directory, uploadResults, filePaths, dirPath)
			};
		}
		return entry;
	}) as Entry[];

	if (mimeTypeMismatches.length > 0) {
		console.error('\n⚠️  MIME TYPE MISMATCHES DETECTED IN MANIFEST:');
		mimeTypeMismatches.forEach(m => console.error(`   ${m}`));
		console.error('');
	}

	const result = {
		$type: 'place.wisp.fs#directory' as const,
		type: 'directory' as const,
		entries: updatedEntries
	};

	return result;
}

function getExpectedMimeType(filename: string): string | null {
	const ext = filename.toLowerCase().split('.').pop();
	const mimeMap: Record<string, string> = {
		'html': 'text/html',
		'htm': 'text/html',
		'css': 'text/css',
		'js': 'text/javascript',
		'mjs': 'text/javascript',
		'json': 'application/json',
		'jpg': 'image/jpeg',
		'jpeg': 'image/jpeg',
		'png': 'image/png',
		'gif': 'image/gif',
		'webp': 'image/webp',
		'svg': 'image/svg+xml',
	};
	return ext ? (mimeMap[ext] || null) : null;
}
