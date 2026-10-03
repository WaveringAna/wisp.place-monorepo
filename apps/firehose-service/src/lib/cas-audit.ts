import { parseCasKey } from '@wispplace/fs-utils'

/**
 * Audit of content-addressed objects (CAS_STORAGE.md). The key names the blob CID and the writer verified
 * the bytes against it, so the object's recorded `sourceCid` must be that CID. No site, owner or PDS is
 * involved: a CAS body belongs to every site that references it.
 */

export type CasAuditKind = 'cas_match' | 'cas_missing_source_identity' | 'cas_source_cid_mismatch' | 'cas_malformed_key'

export interface CasAuditFinding {
	kind: CasAuditKind
	key: string
	expectedCid?: string
	observedCid?: string
}

export function auditCasObject(key: string, observed: { sourceCid?: string }): CasAuditFinding {
	const parsed = parseCasKey(key)
	if (!parsed) return { kind: 'cas_malformed_key', key }
	if (!observed.sourceCid) return { kind: 'cas_missing_source_identity', key }
	if (observed.sourceCid !== parsed.cid) {
		return { kind: 'cas_source_cid_mismatch', key, expectedCid: parsed.cid, observedCid: observed.sourceCid }
	}
	return { kind: 'cas_match', key }
}
