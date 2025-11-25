import type { Directory } from "@wisp/lexicons/types/place/wisp/fs";

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
