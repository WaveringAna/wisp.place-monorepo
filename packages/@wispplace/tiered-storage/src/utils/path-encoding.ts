/**
 * Encode a key to be safe for use as a filesystem path.
 *
 * @param key - The key to encode
 * @param encodeColons - Whether to encode colons as %3A (default: false)
 * @returns Filesystem-safe encoded key
 *
 * @remarks
 * Preserves forward slashes to create directory structure.
 * Encodes characters that are problematic in filenames:
 * - Backslash (\) → %5C
 * - Colon (:) → %3A (when encodeColons is true, invalid on Windows)
 * - Asterisk (*) → %2A
 * - Question mark (?) → %3F
 * - Quote (") → %22
 * - Less than (<) → %3C
 * - Greater than (>) → %3E
 * - Pipe (|) → %7C
 * - Percent (%) → %25
 * - Null byte → %00
 *
 * @example
 * ```typescript
 * const key = 'did:plc:abc123/site/index.html';
 *
 * // Encode colons (Windows/cross-platform)
 * const encoded = encodeKey(key, true);
 * // Result: 'did%3Aplc%3Aabc123/site/index.html'
 * // Creates: cache/did%3Aplc%3Aabc123/site/index.html
 *
 * // Preserve colons (Unix/macOS with readable paths)
 * const readable = encodeKey(key, false);
 * // Result: 'did:plc:abc123/site/index.html'
 * // Creates: cache/did:plc:abc123/site/index.html
 * ```
 */
export function encodeKey(key: string, encodeColons = false): string {
	let result = key
		.replace(/%/g, '%25') // Must be first!
		.replace(/\\/g, '%5C');

	if (encodeColons) {
		result = result.replace(/:/g, '%3A');
	}

	return result
		.replace(/\*/g, '%2A')
		.replace(/\?/g, '%3F')
		.replace(/"/g, '%22')
		.replace(/</g, '%3C')
		.replace(/>/g, '%3E')
		.replace(/\|/g, '%7C')
		.replace(/\0/g, '%00');
}

/**
 * Decode a filesystem-safe key back to original form.
 *
 * @param encoded - The encoded key
 * @param decodeColons - Whether to decode %3A to : (default: false)
 * @returns Original key
 *
 * @example
 * ```typescript
 * const encoded = 'did%3Aplc%3Aabc123/site/index.html';
 *
 * // Decode with colons
 * const key = decodeKey(encoded, true);
 * // Result: 'did:plc:abc123/site/index.html'
 *
 * // Decode without colons (already readable)
 * const readable = decodeKey('did:plc:abc123/site/index.html', false);
 * // Result: 'did:plc:abc123/site/index.html'
 * ```
 */
export function decodeKey(encoded: string, decodeColons = false): string {
	let result = encoded
		.replace(/%5C/g, '\\')
		.replace(/%2A/g, '*')
		.replace(/%3F/g, '?')
		.replace(/%22/g, '"')
		.replace(/%3C/g, '<')
		.replace(/%3E/g, '>')
		.replace(/%7C/g, '|')
		.replace(/%00/g, '\0');

	if (decodeColons) {
		result = result.replace(/%3A/g, ':');
	}

	return result.replace(/%25/g, '%'); // Must be last!
}
