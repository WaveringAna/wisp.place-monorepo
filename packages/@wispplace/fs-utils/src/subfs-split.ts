import type { Directory } from '@wispplace/lexicons/types/place/wisp/fs'

/**
 * Estimate the JSON size of a directory tree
 */
export function estimateDirectorySize(directory: Directory): number {
	return JSON.stringify(directory).length
}

/**
 * Count files in a directory tree
 */
export function countFilesInDirectory(directory: Directory): number {
	let count = 0
	for (const entry of directory.entries) {
		if ('type' in entry.node && entry.node.type === 'file') {
			count++
		} else if ('type' in entry.node && entry.node.type === 'directory') {
			count += countFilesInDirectory(entry.node as Directory)
		}
	}
	return count
}

export interface LargeDirectory {
	path: string
	directory: Directory
	size: number
	fileCount: number
}

function describeDirectory(path: string, directory: Directory): LargeDirectory {
	return { path, directory, size: estimateDirectorySize(directory), fileCount: countFilesInDirectory(directory) }
}

function childDirectories(target: LargeDirectory): LargeDirectory[] {
	return target.directory.entries.flatMap((entry) =>
		'type' in entry.node && entry.node.type === 'directory'
			? [describeDirectory(`${target.path}/${entry.name}`, entry.node as Directory)]
			: [],
	)
}

/**
 * Find all directories in a tree with their paths and sizes
 */
export function findLargeDirectories(directory: Directory, currentPath: string = ''): LargeDirectory[] {
	const result: LargeDirectory[] = []

	for (const entry of directory.entries) {
		if ('type' in entry.node && entry.node.type === 'directory') {
			const dirPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
			const dir = entry.node as Directory
			result.push(describeDirectory(dirPath, dir))

			// Recursively find subdirectories
			const subdirs = findLargeDirectories(dir, dirPath)
			result.push(...subdirs)
		}
	}

	return result
}

/**
 * The directory to move out into subfs records when `target` is chosen: the
 * target itself, or its largest subdirectory (recursively) when that one is
 * too big for a single record. Chunking only divides a directory's own
 * entries, so an oversized child would otherwise land whole in one chunk,
 * over `maxSize` and the lexicon's 500-entry limit.
 */
export function findSplittableDirectory(target: LargeDirectory, maxSize: number): LargeDirectory {
	const largestChild = childDirectories(target).reduce<LargeDirectory | null>(
		(largest, child) => (!largest || child.size > largest.size ? child : largest),
		null,
	)
	return largestChild && largestChild.size > maxSize ? findSplittableDirectory(largestChild, maxSize) : target
}

/**
 * Replace a directory with a subfs node in the tree
 */
export function replaceDirectoryWithSubfs(directory: Directory, targetPath: string, subfsUri: string): Directory {
	const pathParts = targetPath.split('/')
	const targetName = pathParts[pathParts.length - 1]

	// If this is a root-level directory
	if (pathParts.length === 1) {
		const newEntries = directory.entries.map((entry) => {
			if (entry.name === targetName && 'type' in entry.node && entry.node.type === 'directory') {
				return {
					name: entry.name,
					node: {
						$type: 'place.wisp.fs#subfs' as const,
						type: 'subfs' as const,
						subject: subfsUri,
						flat: false, // Preserve directory structure
					},
				}
			}
			return entry
		})

		return {
			$type: 'place.wisp.fs#directory' as const,
			type: 'directory' as const,
			entries: newEntries,
		}
	}

	// Recursively navigate to parent directory. Match the whole first
	// segment: a prefix match would also descend into `a` for `assets/...`.
	const newEntries = directory.entries.map((entry) => {
		if ('type' in entry.node && entry.node.type === 'directory') {
			if (entry.name === pathParts[0]) {
				const remainingPath = pathParts.slice(1).join('/')
				return {
					name: entry.name,
					node: {
						...replaceDirectoryWithSubfs(entry.node as Directory, remainingPath, subfsUri),
						$type: 'place.wisp.fs#directory' as const,
					},
				}
			}
		}
		return entry
	})

	return {
		$type: 'place.wisp.fs#directory' as const,
		type: 'directory' as const,
		entries: newEntries,
	}
}

/**
 * Split a large directory into multiple smaller chunks that each fit within maxSize
 * Used when a single directory is too large for one subfs record
 */
export function splitDirectoryIntoChunks(directory: Directory, maxSize: number): Directory[] {
	const chunk = (entries: Directory['entries']): Directory => ({
		$type: 'place.wisp.fs#directory' as const,
		type: 'directory' as const,
		entries,
	})
	const emptySize = estimateDirectorySize(chunk([]))
	const chunks: Directory[] = []
	let currentChunkEntries: Directory['entries'] = []
	let currentChunkSize = emptySize

	for (const entry of directory.entries) {
		// The entry plus a separating comma
		const entrySize = JSON.stringify(entry).length + 1

		// If adding this entry would exceed max size, start a new chunk
		if (currentChunkEntries.length > 0 && currentChunkSize + entrySize > maxSize) {
			chunks.push(chunk(currentChunkEntries))
			currentChunkEntries = []
			currentChunkSize = emptySize
		}

		currentChunkEntries.push(entry)
		currentChunkSize += entrySize
	}

	// Add the last chunk if it has entries
	if (currentChunkEntries.length > 0) chunks.push(chunk(currentChunkEntries))

	return chunks
}
