import type { BlobRef } from "@atproto/api";
import type { Directory, Entry, File } from "@wisp/lexicons/types/place/wisp/fs";

export interface UploadedFile {
	name: string;
	content: Buffer;
	mimeType: string;
	size: number;
	compressed?: boolean;
	base64Encoded?: boolean;
	originalMimeType?: string;
}

export interface FileUploadResult {
	hash: string;
	blobRef: BlobRef;
	encoding?: 'gzip';
	mimeType?: string;
	base64?: boolean;
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
		// Skip undefined/null files (defensive)
		if (!file || !file.name) {
			console.error('Skipping undefined or invalid file in processUploadedFiles');
			continue;
		}

		// Remove any base folder name from the path
		const normalizedPath = file.name.replace(/^[^\/]*\//, '');

		// Skip files in .git directories
		if (normalizedPath.startsWith('.git/') || normalizedPath === '.git') {
			continue;
		}

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
 * Update file blobs in directory structure after upload
 * Uses path-based matching to correctly match files in nested directories
 * Filters out files that were not successfully uploaded
 */
export function updateFileBlobs(
	directory: Directory,
	uploadResults: FileUploadResult[],
	filePaths: string[],
	currentPath: string = '',
	successfulPaths?: Set<string>
): Directory {
	const updatedEntries = directory.entries.map(entry => {
		if ('type' in entry.node && entry.node.type === 'file') {
			// Build the full path for this file
			const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

			// If successfulPaths is provided, skip files that weren't successfully uploaded
			if (successfulPaths && !successfulPaths.has(fullPath)) {
				return null; // Filter out failed files
			}

			// Find exact match in filePaths (need to handle normalized paths)
			const fileIndex = filePaths.findIndex((path) => {
				// Normalize both paths by removing leading base folder
				const normalizedUploadPath = path.replace(/^[^\/]*\//, '');
				const normalizedEntryPath = fullPath;
				return normalizedUploadPath === normalizedEntryPath || path === fullPath;
			});

			if (fileIndex !== -1 && uploadResults[fileIndex]) {
				const result = uploadResults[fileIndex];
				const blobRef = result.blobRef;

				return {
					...entry,
					node: {
						$type: 'place.wisp.fs#file' as const,
						type: 'file' as const,
						blob: blobRef,
						...(result.encoding && { encoding: result.encoding }),
						...(result.mimeType && { mimeType: result.mimeType }),
						...(result.base64 && { base64: result.base64 })
					}
				};
			} else {
				console.error(`Could not find blob for file: ${fullPath}`);
				return null; // Filter out files without blobs
			}
		} else if ('type' in entry.node && entry.node.type === 'directory') {
			const dirPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
			return {
				...entry,
				node: updateFileBlobs(entry.node as Directory, uploadResults, filePaths, dirPath, successfulPaths)
			};
		}
		return entry;
	}).filter(entry => entry !== null) as Entry[]; // Remove null entries (failed files)

	const result = {
		$type: 'place.wisp.fs#directory' as const,
		type: 'directory' as const,
		entries: updatedEntries
	};

	return result;
}

/**
 * Count files in a directory tree
 */
export function countFilesInDirectory(directory: Directory): number {
	let count = 0;
	for (const entry of directory.entries) {
		if ('type' in entry.node && entry.node.type === 'file') {
			count++;
		} else if ('type' in entry.node && entry.node.type === 'directory') {
			count += countFilesInDirectory(entry.node as Directory);
		}
	}
	return count;
}

/**
 * Recursively collect file CIDs from entries for incremental update tracking
 */
export function collectFileCidsFromEntries(entries: Entry[], pathPrefix: string, fileCids: Record<string, string>): void {
	for (const entry of entries) {
		const currentPath = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
		const node = entry.node;

		if ('type' in node && node.type === 'directory' && 'entries' in node) {
			collectFileCidsFromEntries(node.entries, currentPath, fileCids);
		} else if ('type' in node && node.type === 'file' && 'blob' in node) {
			const fileNode = node as File;
			// Extract CID from blob ref
			if (fileNode.blob && fileNode.blob.ref) {
				const cid = fileNode.blob.ref.toString();
				fileCids[currentPath] = cid;
			}
		}
	}
}
