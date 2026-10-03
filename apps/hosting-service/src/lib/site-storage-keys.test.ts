import { describe, expect, test } from 'bun:test'
import { casKey } from '@wispplace/fs-utils'
import { resolveStorageKey, rewrittenStorageKey } from './site-storage-keys'

const CID = `bafkrei${'a'.repeat(52)}`
const OBJECT = casKey({ cid: CID, path: 'a.css', mimeType: 'text/css' })

describe('resolveStorageKey', () => {
	test('uses the CAS key for a mapped path, with or without a leading slash', () => {
		expect(resolveStorageKey('did:plc:x', 'site', 'a.css', { 'a.css': OBJECT })).toBe(OBJECT)
		expect(resolveStorageKey('did:plc:x', 'site', '/a.css', { 'a.css': OBJECT })).toBe(OBJECT)
	})

	test('has no key for a path the mapping does not cover, and never guesses a legacy one', () => {
		expect(resolveStorageKey('did:plc:x', 'site', 'b.css', { 'a.css': OBJECT })).toBeNull()
	})

	test('has no key for any path when the site has no mapping at all', () => {
		expect(resolveStorageKey('did:plc:x', 'site', 'a.css', null)).toBeNull()
		expect(resolveStorageKey('did:plc:x', 'site', 'a.css', {})).toBeNull()
	})

	test('keeps pre-rewritten HTML per site, even when a mapping names the same path', () => {
		expect(resolveStorageKey('did:plc:x', 'site', '.rewritten/a.html', null)).toBe('did:plc:x/site/.rewritten/a.html')
		expect(resolveStorageKey('did:plc:x', 'site', '.rewritten/a.html', { '.rewritten/a.html': OBJECT })).toBe(
			'did:plc:x/site/.rewritten/a.html',
		)
	})

	test.each([
		'constructor',
		'toString',
		'__proto__',
		'hasOwnProperty',
	])('does not resolve the inherited property %s', (path) => {
		expect(resolveStorageKey('did:plc:x', 'site', path, { 'a.css': OBJECT })).toBeNull()
	})
})

describe('rewrittenStorageKey', () => {
	test('joins did, rkey and path under .rewritten/', () => {
		expect(rewrittenStorageKey('did:plc:x', 'site', 'dir/a.html')).toBe('did:plc:x/site/.rewritten/dir/a.html')
		expect(rewrittenStorageKey('did:plc:x', 'site', '/dir/a.html')).toBe('did:plc:x/site/.rewritten/dir/a.html')
	})
})
