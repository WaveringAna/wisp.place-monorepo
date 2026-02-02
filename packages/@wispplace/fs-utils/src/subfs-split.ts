import type { Directory } from "@wispplace/lexicons/types/place/wisp/fs";

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
						subject: subfsUri,
						flat: false  // Preserve directory structure
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
					node: {
						...replaceDirectoryWithSubfs(entry.node as Directory, remainingPath, subfsUri),
						$type: 'place.wisp.fs#directory' as const
					}
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

/**
 * Split a large directory into multiple smaller chunks that each fit within maxSize
 * Used when a single directory is too large for one subfs record
 */
export function splitDirectoryIntoChunks(directory: Directory, maxSize: number): Directory[] {
	const chunks: Directory[] = [];
	let currentChunkEntries: Directory['entries'] = [];
	let currentChunkSize = 100; // Base size for directory structure overhead

	for (const entry of directory.entries) {
		const entrySize = JSON.stringify(entry).length;

		// If adding this entry would exceed max size, start a new chunk
		if (currentChunkEntries.length > 0 && currentChunkSize + entrySize > maxSize) {
			chunks.push({
				$type: 'place.wisp.fs#directory' as const,
				type: 'directory' as const,
				entries: currentChunkEntries
			});
			currentChunkEntries = [];
			currentChunkSize = 100;
		}

		currentChunkEntries.push(entry);
		currentChunkSize += entrySize;
	}

	// Add the last chunk if it has entries
	if (currentChunkEntries.length > 0) {
		chunks.push({
			$type: 'place.wisp.fs#directory' as const,
			type: 'directory' as const,
			entries: currentChunkEntries
		});
	}

	return chunks;
}
