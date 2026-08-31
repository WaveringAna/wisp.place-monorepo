import { describe, expect, it } from 'bun:test'
import { normalizeSitePath, sanitizePath } from './path'

describe('normalizeSitePath', () => {
	it('accepts canonical relative paths and only normalizes an opted-in trailing slash', () => {
		expect(normalizeSitePath('')).toBe('')
		expect(normalizeSitePath('assets/images/logo.svg')).toBe('assets/images/logo.svg')
		expect(normalizeSitePath('did:plc:example/site/index.html')).toBe('did:plc:example/site/index.html')
		expect(normalizeSitePath('assets/')).toBeNull()
		expect(normalizeSitePath('assets/', { allowTrailingSlash: true })).toBe('assets')
	})

	it('rejects traversal, absolute, Windows, control, and encoded traversal paths', () => {
		const invalidPaths = [
			'/absolute/path',
			'//network/share',
			'../secret.txt',
			'nested/../secret.txt',
			'nested/./file.txt',
			'nested//file.txt',
			'..\\secret.txt',
			'nested\\file.txt',
			'C:/Windows/system.ini',
			'C:\\Windows\\system.ini',
			'assets/C:/Windows/system.ini',
			'file\0name.txt',
			'file\u001fname.txt',
			'file\u007fname.txt',
			'%00name.txt',
			'%2e%2e%2fsecret.txt',
			'%2e%2e%5csecret.txt',
			decodeURIComponent('%2e%2e%2fsecret.txt'),
			decodeURIComponent('%2e%2e%5csecret.txt'),
		]

		for (const path of invalidPaths) {
			expect(normalizeSitePath(path)).toBeNull()
		}
	})

	it('rejects paths that would collide after lossy normalization or exceed bounds', () => {
		expect(normalizeSitePath('index.html')).toBe('index.html')
		expect(normalizeSitePath('nested/../index.html')).toBeNull()
		expect(normalizeSitePath('a'.repeat(256))).toBeNull()
		expect(normalizeSitePath('a'.repeat(4097))).toBeNull()
		expect(normalizeSitePath(Array.from({ length: 129 }, () => 'a').join('/'))).toBeNull()
	})
})

describe('sanitizePath', () => {
	it('keeps legacy lossy behavior but makes Windows separators and drives safe', () => {
		expect(sanitizePath('..\\outside\\file.txt')).toBe('outside/file.txt')
		expect(sanitizePath('C:\\sites\\index.html')).toBe('sites/index.html')
		expect(sanitizePath('assets/C:/Windows/index.html')).toBe('assets/Windows/index.html')
		expect(sanitizePath('nested\\..\\safe.txt')).toBe('nested/safe.txt')
	})
})
