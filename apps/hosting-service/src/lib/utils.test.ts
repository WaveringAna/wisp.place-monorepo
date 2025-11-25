import { describe, test, expect } from 'bun:test'
import { sanitizePath, extractBlobCid } from './utils'
import { CID } from 'multiformats'

describe('sanitizePath', () => {
	test('allows normal file paths', () => {
		expect(sanitizePath('index.html')).toBe('index.html')
		expect(sanitizePath('css/styles.css')).toBe('css/styles.css')
		expect(sanitizePath('images/logo.png')).toBe('images/logo.png')
		expect(sanitizePath('js/app.js')).toBe('js/app.js')
	})

	test('allows deeply nested paths', () => {
		expect(sanitizePath('assets/images/icons/favicon.ico')).toBe('assets/images/icons/favicon.ico')
		expect(sanitizePath('a/b/c/d/e/f.txt')).toBe('a/b/c/d/e/f.txt')
	})

	test('removes leading slashes', () => {
		expect(sanitizePath('/index.html')).toBe('index.html')
		expect(sanitizePath('//index.html')).toBe('index.html')
		expect(sanitizePath('///index.html')).toBe('index.html')
		expect(sanitizePath('/css/styles.css')).toBe('css/styles.css')
	})

	test('blocks parent directory traversal', () => {
		expect(sanitizePath('../etc/passwd')).toBe('etc/passwd')
		expect(sanitizePath('../../etc/passwd')).toBe('etc/passwd')
		expect(sanitizePath('../../../etc/passwd')).toBe('etc/passwd')
		expect(sanitizePath('css/../../../etc/passwd')).toBe('css/etc/passwd')
	})

	test('blocks directory traversal in middle of path', () => {
		expect(sanitizePath('images/../../../etc/passwd')).toBe('images/etc/passwd')
		// Note: sanitizePath only filters out ".." segments, doesn't resolve paths
		expect(sanitizePath('a/b/../c')).toBe('a/b/c')
		expect(sanitizePath('a/../b/../c')).toBe('a/b/c')
	})

	test('removes current directory references', () => {
		expect(sanitizePath('./index.html')).toBe('index.html')
		expect(sanitizePath('././index.html')).toBe('index.html')
		expect(sanitizePath('css/./styles.css')).toBe('css/styles.css')
		expect(sanitizePath('./css/./styles.css')).toBe('css/styles.css')
	})

	test('removes empty path segments', () => {
		expect(sanitizePath('css//styles.css')).toBe('css/styles.css')
		expect(sanitizePath('css///styles.css')).toBe('css/styles.css')
		expect(sanitizePath('a//b//c')).toBe('a/b/c')
	})

	test('blocks null bytes', () => {
		// Null bytes cause the entire segment to be filtered out
		expect(sanitizePath('index.html\0.txt')).toBe('')
		expect(sanitizePath('test\0')).toBe('')
		// Null byte in middle segment
		expect(sanitizePath('css/bad\0name/styles.css')).toBe('css/styles.css')
	})

	test('handles mixed attacks', () => {
		expect(sanitizePath('/../../../etc/passwd')).toBe('etc/passwd')
		expect(sanitizePath('/./././../etc/passwd')).toBe('etc/passwd')
		expect(sanitizePath('//../../.\0./etc/passwd')).toBe('etc/passwd')
	})

	test('handles edge cases', () => {
		expect(sanitizePath('')).toBe('')
		expect(sanitizePath('/')).toBe('')
		expect(sanitizePath('//')).toBe('')
		expect(sanitizePath('.')).toBe('')
		expect(sanitizePath('..')).toBe('')
		expect(sanitizePath('../..')).toBe('')
	})

	test('preserves valid special characters in filenames', () => {
		expect(sanitizePath('file-name.html')).toBe('file-name.html')
		expect(sanitizePath('file_name.html')).toBe('file_name.html')
		expect(sanitizePath('file.name.html')).toBe('file.name.html')
		expect(sanitizePath('file (1).html')).toBe('file (1).html')
		expect(sanitizePath('file@2x.png')).toBe('file@2x.png')
	})

	test('handles Unicode characters', () => {
		expect(sanitizePath('文件.html')).toBe('文件.html')
		expect(sanitizePath('файл.html')).toBe('файл.html')
		expect(sanitizePath('ファイル.html')).toBe('ファイル.html')
	})
})

describe('extractBlobCid', () => {
	const TEST_CID = 'bafkreid7ybejd5s2vv2j7d4aajjlmdgazguemcnuliiyfn6coxpwp2mi6y'
	
	test('extracts CID from IPLD link', () => {
		const blobRef = { $link: TEST_CID }
		expect(extractBlobCid(blobRef)).toBe(TEST_CID)
	})

	test('extracts CID from typed BlobRef with CID object', () => {
		const cid = CID.parse(TEST_CID)
		const blobRef = { ref: cid }
		const result = extractBlobCid(blobRef)
		expect(result).toBe(TEST_CID)
	})

	test('extracts CID from typed BlobRef with IPLD link', () => {
		const blobRef = { 
			ref: { $link: TEST_CID }
		}
		expect(extractBlobCid(blobRef)).toBe(TEST_CID)
	})

	test('extracts CID from untyped BlobRef', () => {
		const blobRef = { cid: TEST_CID }
		expect(extractBlobCid(blobRef)).toBe(TEST_CID)
	})

	test('returns null for invalid blob ref', () => {
		expect(extractBlobCid(null)).toBe(null)
		expect(extractBlobCid(undefined)).toBe(null)
		expect(extractBlobCid({})).toBe(null)
		expect(extractBlobCid('not-an-object')).toBe(null)
		expect(extractBlobCid(123)).toBe(null)
	})

	test('returns null for malformed objects', () => {
		expect(extractBlobCid({ wrongKey: 'value' })).toBe(null)
		expect(extractBlobCid({ ref: 'not-a-cid' })).toBe(null)
		expect(extractBlobCid({ ref: {} })).toBe(null)
	})

	test('handles nested structures from AT Proto API', () => {
		// Real structure from AT Proto
		const blobRef = {
			$type: 'blob',
			ref: CID.parse(TEST_CID),
			mimeType: 'text/html',
			size: 1234
		}
		expect(extractBlobCid(blobRef)).toBe(TEST_CID)
	})

	test('handles BlobRef with additional properties', () => {
		const blobRef = {
			ref: { $link: TEST_CID },
			mimeType: 'image/png',
			size: 5678,
			someOtherField: 'value'
		}
		expect(extractBlobCid(blobRef)).toBe(TEST_CID)
	})

	test('prioritizes checking IPLD link first', () => {
		// Direct $link takes precedence
		const directLink = { $link: TEST_CID }
		expect(extractBlobCid(directLink)).toBe(TEST_CID)
	})

	test('handles CID v0 format', () => {
		const cidV0 = 'QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx'
		const blobRef = { $link: cidV0 }
		expect(extractBlobCid(blobRef)).toBe(cidV0)
	})

	test('handles CID v1 format', () => {
		const cidV1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
		const blobRef = { $link: cidV1 }
		expect(extractBlobCid(blobRef)).toBe(cidV1)
	})
})
