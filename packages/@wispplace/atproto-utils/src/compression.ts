import { gzipSync } from 'zlib';

/**
 * Determine if a file should be gzip compressed based on its MIME type and filename
 */
export function shouldCompressFile(mimeType: string, fileName?: string): boolean {
	// Never compress _redirects file - it needs to be plain text for the hosting service
	if (fileName && (fileName.endsWith('/_redirects') || fileName === '_redirects')) {
		return false;
	}

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
 * Determines if a MIME type should benefit from gzip compression.
 * Returns true for text-based web assets (HTML, CSS, JS, JSON, XML, SVG).
 * Returns false for already-compressed formats (images, video, audio, PDFs).
 */
export function shouldCompressMimeType(mimeType: string | undefined): boolean {
	if (!mimeType) return false;

	const mime = mimeType.toLowerCase();

	// Text-based web assets and uncompressed audio that benefit from compression
	const compressibleTypes = [
		'text/html',
		'text/css',
		'text/javascript',
		'application/javascript',
		'application/x-javascript',
		'text/xml',
		'application/xml',
		'application/json',
		'text/plain',
		'image/svg+xml',
		// Uncompressed audio formats
		'audio/wav',
		'audio/wave',
		'audio/x-wav',
		'audio/aiff',
		'audio/x-aiff',
	];

	if (compressibleTypes.some(type => mime === type || mime.startsWith(type))) {
		return true;
	}

	// Already-compressed formats that should NOT be double-compressed
	const alreadyCompressedPrefixes = [
		'video/',
		'audio/',
		'image/',
		'application/pdf',
		'application/zip',
		'application/gzip',
	];

	if (alreadyCompressedPrefixes.some(prefix => mime.startsWith(prefix))) {
		return false;
	}

	// Default to not compressing for unknown types
	return false;
}

/**
 * Compress a file using gzip with deterministic output
 */
export function compressFile(content: Buffer): Buffer {
	return gzipSync(content, {
		level: 9
	});
}
