import type { BlobRef } from "@atproto/api";
import type { Record, Directory, File, Entry } from "../lexicons/types/place/wisp/fs";
import { validateRecord } from "../lexicons/types/place/wisp/fs";
import { gzipSync } from 'zlib';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import { createHash } from 'crypto';
import * as mf from 'multiformats';

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
 * Determine if a file should be gzip compressed based on its MIME type
 */
export function shouldCompressFile(mimeType: string): boolean {
	// Compress text-based files and uncompressed audio formats
	const compressibleTypes = [
		'text/html',
		'text/css',
		'text/javascript',
		'application/javascript',
		'application/json',
		'image/svg+xml',
		'text/xml',
		'application/xml',
		'text/plain',
		'application/x-javascript',
		// Uncompressed audio formats (WAV, AIFF, etc.)
		'audio/wav',
		'audio/wave',
		'audio/x-wav',
		'audio/aiff',
		'audio/x-aiff'
	];

	// Check if mime type starts with any compressible type
	return compressibleTypes.some(type => mimeType.startsWith(type));
}

/**
 * Compress a file using gzip with deterministic output
 */
export function compressFile(content: Buffer): Buffer {
	return gzipSync(content, {
		level: 9
	});
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
 * Create the manifest record for a site
 */
export function createManifest(
	siteName: string,
	root: Directory,
	fileCount: number
): Record {
	const manifest = {
		$type: 'place.wisp.fs' as const,
		site: siteName,
		root,
		fileCount,
		createdAt: new Date().toISOString()
	};

	// Validate the manifest before returning
	const validationResult = validateRecord(manifest);
	if (!validationResult.success) {
		throw new Error(`Invalid manifest: ${validationResult.error?.message || 'Validation failed'}`);
	}

	return manifest;
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
 * Compute CID (Content Identifier) for blob content
 * Uses the same algorithm as AT Protocol: CIDv1 with raw codec and SHA-256
 * Based on @atproto/common/src/ipld.ts sha256RawToCid implementation
 */
export function computeCID(content: Buffer): string {
	// Use node crypto to compute sha256 hash (same as AT Protocol)
	const hash = createHash('sha256').update(content).digest();
	// Create digest object from hash bytes
	const digest = mf.digest.create(sha256.code, hash);
	// Create CIDv1 with raw codec
	const cid = CID.createV1(raw.code, digest);
	return cid.toString();
}

/**
 * Extract blob information from a directory tree
 * Returns a map of file paths to their blob refs and CIDs
 */
export function extractBlobMap(
	directory: Directory,
	currentPath: string = ''
): Map<string, { blobRef: BlobRef; cid: string }> {
	const blobMap = new Map<string, { blobRef: BlobRef; cid: string }>();

	for (const entry of directory.entries) {
		const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

		if ('type' in entry.node && entry.node.type === 'file') {
			const fileNode = entry.node as File;
			// AT Protocol SDK returns BlobRef class instances, not plain objects
			// The ref is a CID instance that can be converted to string
			if (fileNode.blob && fileNode.blob.ref) {
				const cidString = fileNode.blob.ref.toString();
				blobMap.set(fullPath, {
					blobRef: fileNode.blob,
					cid: cidString
				});
			}
		} else if ('type' in entry.node && entry.node.type === 'directory') {
			const subMap = extractBlobMap(entry.node as Directory, fullPath);
			subMap.forEach((value, key) => blobMap.set(key, value));
		}
		// Skip subfs nodes - they don't contain blobs in the main tree
	}

	return blobMap;
}

/**
 * Extract all subfs URIs from a directory tree with their mount paths
 */
export function extractSubfsUris(
	directory: Directory,
	currentPath: string = ''
): Array<{ uri: string; path: string }> {
	const uris: Array<{ uri: string; path: string }> = [];

	for (const entry of directory.entries) {
		const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

		if ('type' in entry.node) {
			if (entry.node.type === 'subfs') {
				// Subfs node with subject URI
				const subfsNode = entry.node as any;
				if (subfsNode.subject) {
					uris.push({ uri: subfsNode.subject, path: fullPath });
				}
			} else if (entry.node.type === 'directory') {
				// Recursively search subdirectories
				const subUris = extractSubfsUris(entry.node as Directory, fullPath);
				uris.push(...subUris);
			}
		}
	}

	return uris;
}

/**
 * Estimate the JSON size of a directory tree
 */
export function estimateDirectorySize(directory: Directory): number {
	return JSON.stringify(directory).length;
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
 * Find all directories in a tree with their paths and sizes
 */
export function findLargeDirectories(directory: Directory, currentPath: string = ''): Array<{
	path: string;
	directory: Directory;
	size: number;
	fileCount: number;
}> {
	const result: Array<{ path: string; directory: Directory; size: number; fileCount: number }> = [];

	for (const entry of directory.entries) {
		if ('type' in entry.node && entry.node.type === 'directory') {
			const dirPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
			const dir = entry.node as Directory;
			const size = estimateDirectorySize(dir);
			const fileCount = countFilesInDirectory(dir);

			result.push({ path: dirPath, directory: dir, size, fileCount });

			// Recursively find subdirectories
			const subdirs = findLargeDirectories(dir, dirPath);
			result.push(...subdirs);
		}
	}

	return result;
}

/**
 * Replace a directory with a subfs node in the tree
 */
export function replaceDirectoryWithSubfs(
	directory: Directory,
	targetPath: string,
	subfsUri: string
): Directory {
	const pathParts = targetPath.split('/');
	const targetName = pathParts[pathParts.length - 1];
	const parentPath = pathParts.slice(0, -1).join('/');

	// If this is a root-level directory
	if (pathParts.length === 1) {
		const newEntries = directory.entries.map(entry => {
			if (entry.name === targetName && 'type' in entry.node && entry.node.type === 'directory') {
				return {
					name: entry.name,
					node: {
						$type: 'place.wisp.fs#subfs' as const,
						type: 'subfs' as const,
						subject: subfsUri
					}
				};
			}
			return entry;
		});

		return {
			$type: 'place.wisp.fs#directory' as const,
			type: 'directory' as const,
			entries: newEntries
		};
	}

	// Recursively navigate to parent directory
	const newEntries = directory.entries.map(entry => {
		if ('type' in entry.node && entry.node.type === 'directory') {
			const entryPath = entry.name;
			if (parentPath.startsWith(entryPath) || parentPath === entry.name) {
				const remainingPath = pathParts.slice(1).join('/');
				return {
					name: entry.name,
					node: replaceDirectoryWithSubfs(entry.node as Directory, remainingPath, subfsUri)
				};
			}
		}
		return entry;
	});

	return {
		$type: 'place.wisp.fs#directory' as const,
		type: 'directory' as const,
		entries: newEntries
	};
}
