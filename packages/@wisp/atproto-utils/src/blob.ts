import type { BlobRef } from "@atproto/lexicon";
import type { Directory, File } from "@wisp/lexicons/types/place/wisp/fs";
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import { createHash } from 'crypto';
import * as mf from 'multiformats';

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

interface IpldLink {
	$link: string;
}

interface TypedBlobRef {
	ref: CID | IpldLink;
}

interface UntypedBlobRef {
	cid: string;
}

function isIpldLink(obj: unknown): obj is IpldLink {
	return typeof obj === 'object' && obj !== null && '$link' in obj && typeof (obj as IpldLink).$link === 'string';
}

function isTypedBlobRef(obj: unknown): obj is TypedBlobRef {
	return typeof obj === 'object' && obj !== null && 'ref' in obj;
}

function isUntypedBlobRef(obj: unknown): obj is UntypedBlobRef {
	return typeof obj === 'object' && obj !== null && 'cid' in obj && typeof (obj as UntypedBlobRef).cid === 'string';
}

/**
 * Extract CID from a blob reference (handles multiple blob ref formats)
 */
export function extractBlobCid(blobRef: unknown): string | null {
	if (isIpldLink(blobRef)) {
		return blobRef.$link;
	}

	if (isTypedBlobRef(blobRef)) {
		const ref = blobRef.ref;

		const cid = CID.asCID(ref);
		if (cid) {
			return cid.toString();
		}

		if (isIpldLink(ref)) {
			return ref.$link;
		}
	}

	if (isUntypedBlobRef(blobRef)) {
		return blobRef.cid;
	}

	return null;
}
