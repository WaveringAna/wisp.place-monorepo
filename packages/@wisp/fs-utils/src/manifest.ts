import type { Record, Directory } from "@wisp/lexicons/types/place/wisp/fs";
// import { validateRecord } from "@wisp/lexicons/types/place/wisp/fs";

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
	// const validationResult = validateRecord(manifest);
	// if (!validationResult.success) {
	// 	throw new Error(`Invalid manifest: ${validationResult.error?.message || 'Validation failed'}`);
	// }

	return manifest;
}
