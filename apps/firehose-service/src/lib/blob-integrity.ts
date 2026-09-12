import { MAX_BLOB_SIZE } from '@wispplace/constants'
import { SafeFetchHttpError, type SafeFetchOptions, safeFetch } from '@wispplace/safe-fetch'
import { CID } from 'multiformats/cid'
import { code as rawCodec } from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

export interface BlobSource {
	pds: string
	recordCid: string
	path: string
	blobCid: string
	ownerDid: string
	expectedSize: number
}

export type BlobIntegrityCode =
	| 'BLOB_MISSING'
	| 'BLOB_SIZE_MISMATCH'
	| 'BLOB_CID_MISMATCH'
	| 'BLOB_INVALID_CID'
	| 'BLOB_UNSUPPORTED_CID'

export interface BlobIntegrityDetails extends BlobSource {
	actualSize: number | null
	status?: number
}

function boundedIdentifier(value: string, limit = 512): string {
	return Array.from(value, (character) => {
		const code = character.charCodeAt(0)
		return code <= 0x1f || code === 0x7f ? ' ' : character
	})
		.join('')
		.slice(0, limit)
}

/** Persist only bounded identifiers, never response bytes, URL credentials, or query strings. */
export class BlobIntegrityError extends Error {
	readonly details: BlobIntegrityDetails

	constructor(
		readonly code: BlobIntegrityCode,
		details: BlobIntegrityDetails,
	) {
		super(`Blob integrity failed: ${code}`)
		this.name = 'BlobIntegrityError'
		let pds = ''
		try {
			pds = new URL(details.pds).origin
		} catch {
			/* Do not echo an invalid URL. */
		}
		this.details = {
			pds: boundedIdentifier(pds),
			recordCid: boundedIdentifier(details.recordCid),
			path: boundedIdentifier(details.path, 2048),
			blobCid: boundedIdentifier(details.blobCid),
			ownerDid: boundedIdentifier(details.ownerDid, 2048),
			expectedSize: details.expectedSize,
			actualSize: details.actualSize,
			...(details.status === undefined ? {} : { status: details.status }),
		}
	}
}

/** ATProto blobs use CIDv1/raw/sha256. Never silently accept another codec or hash. */
export async function verifyBlobBytes(source: BlobSource, content: Uint8Array): Promise<void> {
	const details = { ...source, actualSize: content.byteLength }
	if (content.byteLength !== source.expectedSize) throw new BlobIntegrityError('BLOB_SIZE_MISMATCH', details)
	let expected: CID
	try {
		expected = CID.parse(source.blobCid)
	} catch {
		throw new BlobIntegrityError('BLOB_INVALID_CID', details)
	}
	if (expected.version !== 1 || expected.code !== rawCodec || expected.multihash.code !== sha256.code) {
		throw new BlobIntegrityError('BLOB_UNSUPPORTED_CID', details)
	}
	const actual = CID.createV1(rawCodec, await sha256.digest(content))
	if (!expected.equals(actual)) throw new BlobIntegrityError('BLOB_CID_MISMATCH', details)
}

export type BlobFetchOptions = Pick<
	SafeFetchOptions,
	'signal' | 'byteBudget' | 'allowLocalhost' | 'resolver' | 'transport'
>

/** Fetch bounded encoded PDS bytes and verify them before any base64/gzip decoding or cache write. */
export async function fetchVerifiedBlob(source: BlobSource, options: BlobFetchOptions = {}): Promise<Uint8Array> {
	options.signal?.throwIfAborted()
	const query = new URLSearchParams({ did: source.ownerDid, cid: source.blobCid })
	const response = await safeFetch(`${source.pds}/xrpc/com.atproto.sync.getBlob?${query}`, {
		...options,
		maxSize: MAX_BLOB_SIZE,
		timeout: 300000,
		headers: { 'accept-encoding': 'identity' },
	})
	if (!response.ok) {
		void response.body?.cancel().catch(() => undefined)
		if (response.status === 404 || response.status === 410) {
			throw new BlobIntegrityError('BLOB_MISSING', { ...source, actualSize: null, status: response.status })
		}
		throw new SafeFetchHttpError(response)
	}
	const content = new Uint8Array(await response.arrayBuffer())
	options.signal?.throwIfAborted()
	await verifyBlobBytes(source, content)
	options.signal?.throwIfAborted()
	return content
}
