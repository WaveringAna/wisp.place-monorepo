import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Calculate SHA256 checksum of data.
 *
 * @param data - Data to checksum
 * @returns Hex-encoded SHA256 hash
 *
 * @remarks
 * Used for data integrity verification. The checksum is stored in metadata
 * and can be used to detect corruption or tampering.
 *
 * @example
 * ```typescript
 * const data = new TextEncoder().encode('Hello, world!');
 * const checksum = calculateChecksum(data);
 * console.log(checksum); // '315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3'
 * ```
 */
export function calculateChecksum(data: Uint8Array): string {
	const hash = createHash('sha256')
	hash.update(data)
	return hash.digest('hex')
}

/**
 * Verify that data matches an expected checksum.
 *
 * @param data - Data to verify
 * @param expectedChecksum - Expected SHA256 checksum (hex-encoded)
 * @returns true if checksums match, false otherwise
 *
 * @remarks
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @example
 * ```typescript
 * const isValid = verifyChecksum(data, metadata.checksum);
 * if (!isValid) {
 *	 throw new Error('Data corruption detected');
 * }
 * ```
 */
export function verifyChecksum(data: Uint8Array, expectedChecksum: string): boolean {
	const actualChecksum = calculateChecksum(data)

	// Use constant-time comparison to prevent timing attacks
	try {
		return timingSafeEqual(Buffer.from(actualChecksum, 'hex'), Buffer.from(expectedChecksum, 'hex'))
	} catch {
		// If checksums have different lengths, timingSafeEqual throws
		return false
	}
}
