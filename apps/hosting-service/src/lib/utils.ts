import { didWebToHttps, extractBlobCid, getPdsForDid, resolveDid } from '@wispplace/atproto-utils'
import { sanitizePath } from '@wispplace/fs-utils'
import type { Directory, Entry } from '@wispplace/lexicons/types/place/wisp/fs'
import type { Record as WispSettings } from '@wispplace/lexicons/types/place/wisp/settings'
import type { Record as SubfsRecord } from '@wispplace/lexicons/types/place/wisp/subfs'
import { safeFetchJson } from '@wispplace/safe-fetch'
import { getSiteSettingsCache } from './db'

// Re-export shared utilities for local usage and tests
export { extractBlobCid, sanitizePath, resolveDid, getPdsForDid, didWebToHttps }

/**
 * Extract all subfs URIs from a directory tree with their mount paths
 */
export function extractSubfsUris(directory: Directory, currentPath: string = ''): Array<{ uri: string; path: string }> {
	const uris: Array<{ uri: string; path: string }> = []

	for (const entry of directory.entries) {
		const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name

		if ('type' in entry.node) {
			if (entry.node.type === 'subfs') {
				// Subfs node with subject URI
				const subfsNode = entry.node as any
				if (subfsNode.subject) {
					uris.push({ uri: subfsNode.subject, path: fullPath })
				}
			} else if (entry.node.type === 'directory') {
				// Recursively search subdirectories
				const subUris = extractSubfsUris(entry.node as Directory, fullPath)
				uris.push(...subUris)
			}
		}
	}

	return uris
}

/**
 * Fetch a subfs record from the PDS
 */
async function fetchSubfsRecord(uri: string, pdsEndpoint: string): Promise<SubfsRecord | null> {
	try {
		// Parse URI: at://did/collection/rkey
		const parts = uri.replace('at://', '').split('/')
		if (parts.length < 3) {
			console.error('Invalid subfs URI:', uri)
			return null
		}

		const did = parts[0] || ''
		const collection = parts[1] || ''
		const rkey = parts[2] || ''

		// Fetch the record from PDS
		const url = `${pdsEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`
		const response = await safeFetchJson(url)

		if (!response || !response.value) {
			console.error('Subfs record not found:', uri)
			return null
		}

		return response.value as SubfsRecord
	} catch (err) {
		console.error('Failed to fetch subfs record:', uri, err)
		return null
	}
}

/**
 * Replace subfs nodes in a directory tree with their actual content
 * Subfs entries are "merged" - their root entries are hoisted into the parent directory
 * This function is recursive - it will keep expanding until no subfs nodes remain
 * Uses a cache to avoid re-fetching the same subfs records across recursion depths
 */
export async function expandSubfsNodes(
	directory: Directory,
	pdsEndpoint: string,
	depth: number = 0,
	subfsCache: Map<string, SubfsRecord | null> = new Map(),
): Promise<Directory> {
	const MAX_DEPTH = 10 // Prevent infinite loops

	if (depth >= MAX_DEPTH) {
		console.error('Max subfs expansion depth reached, stopping to prevent infinite loop')
		return directory
	}

	// Extract all subfs URIs
	const subfsUris = extractSubfsUris(directory)

	if (subfsUris.length === 0) {
		// No subfs nodes, return as-is
		return directory
	}

	// Filter to only URIs we haven't fetched yet
	const uncachedUris = subfsUris.filter(({ uri }) => !subfsCache.has(uri))

	if (uncachedUris.length > 0) {
		console.log(
			`[Depth ${depth}] Found ${subfsUris.length} subfs references, fetching ${uncachedUris.length} new records (${subfsUris.length - uncachedUris.length} cached)...`,
		)

		// Fetch only uncached subfs records in parallel
		const fetchedRecords = await Promise.all(
			uncachedUris.map(async ({ uri }) => {
				const record = await fetchSubfsRecord(uri, pdsEndpoint)
				return { uri, record }
			}),
		)

		// Add fetched records to cache
		for (const { uri, record } of fetchedRecords) {
			subfsCache.set(uri, record)
		}
	} else {
		console.log(`[Depth ${depth}] Found ${subfsUris.length} subfs references, all cached`)
	}

	// Build a map of path -> root entries to merge using the cache
	// Note: SubFS entries are compatible with FS entries at runtime
	const subfsMap = new Map<string, Entry[]>()
	for (const { uri, path } of subfsUris) {
		const record = subfsCache.get(uri)
		if (record?.root?.entries) {
			subfsMap.set(path, record.root.entries as unknown as Entry[])
		}
	}

	// Replace subfs nodes by merging their root entries into the parent directory
	function replaceSubfsInEntries(entries: Entry[], currentPath: string = ''): Entry[] {
		const result: Entry[] = []

		for (const entry of entries) {
			const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
			const node = entry.node

			if ('type' in node && node.type === 'subfs') {
				// Check if this is a flat merge or subdirectory merge (default to flat if not specified)
				const subfsNode = node as any
				const isFlat = subfsNode.flat !== false // Default to true
				const subfsEntries = subfsMap.get(fullPath)

				if (subfsEntries) {
					console.log(
						`[Depth ${depth}] Merging subfs node at ${fullPath} (${subfsEntries.length} entries, flat: ${isFlat})`,
					)

					if (isFlat) {
						// Flat merge: hoist entries directly into parent directory
						const processedEntries = replaceSubfsInEntries(subfsEntries, currentPath)
						result.push(...processedEntries)
					} else {
						// Subdirectory merge: create a directory with the subfs node's name
						const processedEntries = replaceSubfsInEntries(subfsEntries, fullPath)
						const directoryNode: Directory = {
							type: 'directory',
							entries: processedEntries,
						}
						result.push({
							name: entry.name,
							node: directoryNode as any, // Type assertion needed due to lexicon type complexity
						})
					}
				} else {
					// If not in map yet, preserve the subfs node for next recursion depth
					console.log(`[Depth ${depth}] Subfs at ${fullPath} not yet fetched, preserving for next iteration`)
					result.push(entry)
				}
			} else if ('type' in node && node.type === 'directory' && 'entries' in node) {
				// Recursively process subdirectories
				result.push({
					...entry,
					node: {
						...node,
						entries: replaceSubfsInEntries(node.entries, fullPath),
					},
				})
			} else {
				// Regular file entry
				result.push(entry)
			}
		}

		return result
	}

	const partiallyExpanded = {
		...directory,
		entries: replaceSubfsInEntries(directory.entries),
	}

	// Recursively expand any remaining subfs nodes (e.g., nested subfs inside parent subfs)
	// Pass the cache to avoid re-fetching records
	return expandSubfsNodes(partiallyExpanded, pdsEndpoint, depth + 1, subfsCache)
}

export async function getCachedSettings(did: string, rkey: string): Promise<WispSettings | null> {
	const cached = await getSiteSettingsCache(did, rkey)
	if (!cached) return null

	return {
		$type: 'place.wisp.settings',
		directoryListing: cached.directory_listing,
		spaMode: cached.spa_mode ?? undefined,
		custom404: cached.custom_404 ?? undefined,
		indexFiles: cached.index_files ?? undefined,
		cleanUrls: cached.clean_urls,
		headers: cached.headers ?? undefined,
	}
}
