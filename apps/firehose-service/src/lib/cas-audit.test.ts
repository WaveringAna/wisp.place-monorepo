import { describe, expect, test } from 'bun:test'
import { casKey } from '@wispplace/fs-utils'
import { auditCasObject } from './cas-audit'

const cid = `bafkrei${'a'.repeat(52)}`
const key = casKey({ cid, path: 'a.css', mimeType: 'text/css' })

describe('auditCasObject', () => {
	// A CAS object's identity is in its key, so it can be audited without asking the PDS anything:
	// the source CID the writer recorded must be the one the key names.
	test('accepts an object whose recorded source CID is the key CID', () => {
		expect(auditCasObject(key, { sourceCid: cid })).toEqual({ kind: 'cas_match', key })
	})

	test('flags an object with no recorded source CID', () => {
		expect(auditCasObject(key, {})).toEqual({ kind: 'cas_missing_source_identity', key })
	})

	test('flags an object whose recorded source CID is not the key CID', () => {
		const other = `bafkrei${'b'.repeat(52)}`

		expect(auditCasObject(key, { sourceCid: other })).toEqual({
			kind: 'cas_source_cid_mismatch',
			key,
			expectedCid: cid,
			observedCid: other,
		})
	})

	test('flags a key that is not a CAS key rather than guessing at it', () => {
		expect(auditCasObject('did:plc:x/site/a.css', { sourceCid: cid })).toEqual({
			kind: 'cas_malformed_key',
			key: 'did:plc:x/site/a.css',
		})
	})
})
