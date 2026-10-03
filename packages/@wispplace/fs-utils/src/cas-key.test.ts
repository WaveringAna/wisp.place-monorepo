import { describe, expect, it } from 'bun:test'
import { casKey, casVariant, isCasKey, parseCasKey } from './cas-key'

const CID = 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'

describe('casVariant', () => {
	// Independent golden values (python hashlib over "v1\0mime\0encoding\0base64-flag").
	// Changing any of them re-keys every stored object, so this must stay a deliberate edit.
	it('matches the documented derivation', () => {
		expect(casVariant({ mimeType: 'text/html' })).toBe('ebb2ee7b')
		expect(casVariant({ mimeType: 'text/css', encoding: 'gzip' })).toBe('629c66c8')
		expect(casVariant({})).toBe('51cab812')
		expect(casVariant({ mimeType: 'text/plain', base64: true })).toBe('0d834fbc')
	})

	it('treats missing and empty flags alike, and base64 undefined as false', () => {
		expect(casVariant({ mimeType: '', encoding: '', base64: false })).toBe(casVariant({}))
		expect(casVariant({ mimeType: 'text/html', base64: undefined })).toBe(
			casVariant({ mimeType: 'text/html', base64: false }),
		)
	})

	it('differs when any stored-body-relevant flag differs', () => {
		const base = casVariant({ mimeType: 'text/html', encoding: 'gzip', base64: false })
		expect(casVariant({ mimeType: 'text/plain', encoding: 'gzip', base64: false })).not.toBe(base)
		expect(casVariant({ mimeType: 'text/html', base64: false })).not.toBe(base)
		expect(casVariant({ mimeType: 'text/html', encoding: 'gzip', base64: true })).not.toBe(base)
	})

	it('does not normalize mime case: a different Content-Type is a different object', () => {
		expect(casVariant({ mimeType: 'Text/HTML' })).not.toBe(casVariant({ mimeType: 'text/html' }))
	})

	it('cannot collide by moving a character between fields', () => {
		expect(casVariant({ mimeType: 'ab', encoding: 'c' })).not.toBe(casVariant({ mimeType: 'a', encoding: 'bc' }))
	})
})

describe('casKey', () => {
	const flags = { mimeType: 'text/css' }

	it('lays out cas/{cid}.{variant}.{ext}', () => {
		expect(casKey({ cid: CID, path: 'assets/app.css', ...flags })).toBe(`cas/${CID}.${casVariant(flags)}.css`)
	})

	it('keeps only the last extension, lowercased', () => {
		expect(casKey({ cid: CID, path: 'dist/bundle.TAR.GZ', ...flags })).toEndWith('.gz')
		expect(casKey({ cid: CID, path: 'a/B.JS', mimeType: 'text/javascript' })).toEndWith('.js')
	})

	it.each([
		['no extension', 'LICENSE'],
		['dotfile', '.gitignore'],
		['nested dotfile', 'conf/.htaccess'],
		['trailing dot', 'file.'],
		['dot only in a directory', 'v1.2/readme'],
		['extension with unsafe characters', 'file.c++'],
		['extension that is too long', `file.${'a'.repeat(17)}`],
	])('omits the extension for %s', (_name, path) => {
		expect(casKey({ cid: CID, path, ...flags })).toBe(`cas/${CID}.${casVariant(flags)}`)
	})

	it('keys the same bytes at different extensions apart, and the same extension together', () => {
		const css = casKey({ cid: CID, path: 'a.css', ...flags })
		expect(casKey({ cid: CID, path: 'z/deep/b.css', ...flags })).toBe(css)
		expect(casKey({ cid: CID, path: 'a.txt', ...flags })).not.toBe(css)
	})

	it('keys different cids apart', () => {
		expect(casKey({ cid: `${CID}x`, path: 'a.css', ...flags })).not.toBe(casKey({ cid: CID, path: 'a.css', ...flags }))
	})

	it.each([
		'',
		'has space',
		'a/b',
		'a\\b',
		'a.b',
		'../x',
		'a\0b',
		'é',
		'a'.repeat(513),
	])('rejects the unsafe cid %j', (cid) => {
		expect(() => casKey({ cid, path: 'a.css', ...flags })).toThrow('Invalid CID')
	})

	it('never lets a path influence anything but the extension', () => {
		expect(casKey({ cid: CID, path: '../../etc/passwd.css', ...flags })).toBe(
			casKey({ cid: CID, path: 'a.css', ...flags }),
		)
	})
})

describe('parseCasKey / isCasKey', () => {
	it('round-trips generated keys', () => {
		for (const path of ['a.css', 'LICENSE', 'x/y.min.js']) {
			const key = casKey({ cid: CID, path, mimeType: 'text/plain', encoding: 'gzip' })
			expect(isCasKey(key)).toBe(true)
			const parsed = parseCasKey(key)
			expect(parsed?.cid).toBe(CID)
			expect(parsed?.variant).toBe(casVariant({ mimeType: 'text/plain', encoding: 'gzip' }))
		}
		expect(parseCasKey(casKey({ cid: CID, path: 'a.css' }))?.ext).toBe('css')
		expect(parseCasKey(casKey({ cid: CID, path: 'LICENSE' }))?.ext).toBeUndefined()
	})

	it.each([
		'',
		'did:plc:x/site/index.html',
		`cas/${CID}`,
		`cas/${CID}.ZZZZZZZZ`,
		`cas/${CID}.ebb2ee7b.css/extra`,
		`cas/../${CID}.ebb2ee7b`,
		`cas/${CID}.ebb2ee7B`,
		`cas/${CID}.ebb2ee7b.CSS`,
		`xcas/${CID}.ebb2ee7b`,
		`cas/a/b.ebb2ee7b`,
	])('rejects %j', (key) => {
		expect(parseCasKey(key)).toBeNull()
		expect(isCasKey(key)).toBe(false)
	})
})
