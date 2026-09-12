import { createHash } from 'node:crypto'
import { extractBlobCid } from '@wispplace/atproto-utils'
import type { Directory } from '@wispplace/lexicons/types/place/wisp/fs'

export const VERIFIED_REPAIR_PROTOCOL = '1'
export const VERIFIED_REPAIR_REASON = 'storage-miss:verified-repair'
export const VERIFIED_REPAIR_CAPABILITY_TTL_SECONDS = 30
export const VERIFIED_REPAIR_RECEIPT_TTL_SECONDS = 86_400

export interface VerifiedRepairRequest {
	token: string
	recordCid: string
	manifestFingerprint: string
}

export interface VerifiedSitePreflight {
	recordCid: string
	manifestFingerprint: string
	fileCount: number
	totalBytes: number
}

export interface VerifiedRepairProof {
	recordCid: string
	manifestFingerprint: string
	invalidationStreamId: string
}

export interface VerifiedRepairReceipt extends VerifiedRepairRequest, VerifiedRepairProof {
	did: string
	rkey: string
}

export function parseVerifiedRepairReceipt(
	raw: string,
	request: VerifiedRepairRequest,
	site: { did: string; rkey: string },
): VerifiedRepairReceipt {
	const value: unknown = JSON.parse(raw)
	if (typeof value !== 'object' || value === null) throw new Error('Invalid repair completion proof')
	const receipt = value as Partial<VerifiedRepairReceipt>
	if (
		receipt.token !== request.token ||
		receipt.did !== site.did ||
		receipt.rkey !== site.rkey ||
		receipt.recordCid !== request.recordCid ||
		receipt.manifestFingerprint !== request.manifestFingerprint ||
		typeof receipt.invalidationStreamId !== 'string' ||
		!/^\d+-\d+$/.test(receipt.invalidationStreamId)
	)
		throw new Error('Repair completion proof does not match the verified site')
	return receipt as VerifiedRepairReceipt
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

export function verifiedRepairReceiptKey(stream: string, token: string): string {
	return `revalidate:verified-repair:receipt:${digest(JSON.stringify([stream, token]))}`
}

export function verifiedRepairQuarantineGenerationKey(did: string, rkey: string): string {
	return `revalidate:quarantine-generation:${digest(JSON.stringify([did, rkey]))}`
}

export function verifiedRepairCapabilityKey(stream: string, group: string): string {
	return `revalidate:verified-repair:capability:${digest(JSON.stringify([stream, group]))}`
}

/** Bind the expanded file interpretation and owner, not merely the root record CID. */
export function fingerprintSiteManifest(
	recordCid: string,
	root: Directory,
	owners: ReadonlyMap<string, string>,
): string {
	const entries: unknown[] = []
	const walk = (directory: Directory, prefix: string) => {
		for (const entry of directory.entries) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name
			const node = entry.node
			if ('type' in node && node.type === 'directory' && 'entries' in node) {
				entries.push([path, 'directory'])
				walk(node, path)
			} else if ('type' in node && node.type === 'file' && 'blob' in node) {
				const cid = extractBlobCid(node.blob)
				const owner = owners.get(path)
				if (!cid || !owner) throw new Error('Expanded manifest has an unbound file')
				entries.push([
					path,
					'file',
					owner,
					cid,
					node.blob.size,
					node.encoding ?? null,
					node.mimeType ?? null,
					node.base64 ?? false,
				])
			} else {
				throw new Error('Expanded manifest contains an unsupported node')
			}
		}
	}
	walk(root, '')
	return digest(JSON.stringify([recordCid, entries]))
}

export function parseVerifiedRepairRequest(fields: Record<string, string>): VerifiedRepairRequest | undefined {
	if (fields.reason !== VERIFIED_REPAIR_REASON) return undefined
	if (
		fields.repairProtocol !== VERIFIED_REPAIR_PROTOCOL ||
		!/^[a-f0-9-]{36}$/.test(fields.repairToken ?? '') ||
		!fields.repairRecordCid ||
		fields.repairRecordCid.length > 256 ||
		!/^[a-f0-9]{64}$/.test(fields.repairManifestFingerprint ?? '')
	)
		throw new Error('Invalid verified repair request')
	return {
		token: fields.repairToken!,
		recordCid: fields.repairRecordCid,
		manifestFingerprint: fields.repairManifestFingerprint!,
	}
}
