/**
 * Sanitize a file path to prevent directory traversal attacks
 * Removes any path segments that attempt to go up directories
 */
export function sanitizePath(filePath: string): string {
	// Remove leading slashes
	let cleaned = filePath.replace(/^\/+/, '');

	// Split into segments and filter out dangerous ones
	const segments = cleaned.split('/').filter(segment => {
		// Remove empty segments
		if (!segment || segment === '.') return false;
		// Remove parent directory references
		if (segment === '..') return false;
		// Remove segments with null bytes
		if (segment.includes('\0')) return false;
		return true;
	});

	// Rejoin the safe segments
	return segments.join('/');
}

/**
 * Normalize a path by removing leading base folder names
 */
export function normalizePath(path: string): string {
	return path.replace(/^[^\/]*\//, '');
}
