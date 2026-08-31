import { describe, expect, it } from 'bun:test'
import { normalizeServeRequestPath } from './serve'

describe('normalizeServeRequestPath', () => {
	it('keeps only canonical local request paths', () => {
		expect(normalizeServeRequestPath('/')).toBe('/')
		expect(normalizeServeRequestPath('/assets/app.js')).toBe('/assets/app.js')
		expect(normalizeServeRequestPath('/assets/')).toBe('/assets/')
	})

	it('rejects traversal, encoded structure, Windows paths, and filesystem aliases', () => {
		for (const path of [
			'/../secret.txt',
			'/assets/../secret.txt',
			'/assets%2f..%2fsecret.txt',
			'/safe%00name.txt',
			'/assets\\secret.txt',
			'/C:/Windows/system.ini',
			'/assets/C:/stream',
			'/assets/file.',
			'/assets/file ',
		]) {
			expect(normalizeServeRequestPath(path)).toBeNull()
		}
	})
})
