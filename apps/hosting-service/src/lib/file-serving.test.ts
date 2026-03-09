import { describe, expect, test } from 'bun:test'
import { hasFileExtension } from './file-serving'

describe('hasFileExtension', () => {
	describe('paths with extensions', () => {
		test('simple file extension', () => {
			expect(hasFileExtension('style.css')).toBe(true)
		})

		test('html extension', () => {
			expect(hasFileExtension('index.html')).toBe(true)
		})

		test('nested path with extension', () => {
			expect(hasFileExtension('assets/js/app.js')).toBe(true)
		})

		test('double extension', () => {
			expect(hasFileExtension('archive.tar.gz')).toBe(true)
		})

		test('dotfile with extension', () => {
			expect(hasFileExtension('.htaccess')).toBe(true)
		})

		test('minified file', () => {
			expect(hasFileExtension('bundle.min.js')).toBe(true)
		})

		test('image file', () => {
			expect(hasFileExtension('photo.png')).toBe(true)
		})

		test('sourcemap', () => {
			expect(hasFileExtension('app.js.map')).toBe(true)
		})
	})

	describe('paths without extensions (extensionless files)', () => {
		test('simple name', () => {
			expect(hasFileExtension('about')).toBe(false)
		})

		test('binary-style name with dashes', () => {
			expect(hasFileExtension('wisp-cli-x86_64-linux')).toBe(false)
		})

		test('binary-style name with underscores', () => {
			expect(hasFileExtension('my_binary_v2')).toBe(false)
		})

		test('empty string', () => {
			expect(hasFileExtension('')).toBe(false)
		})

		test('single word', () => {
			expect(hasFileExtension('README')).toBe(false)
		})

		test('path with trailing slash', () => {
			expect(hasFileExtension('somedir/')).toBe(false)
		})
	})

	describe('directory-with-dot edge cases', () => {
		test('dot in directory name, extensionless file', () => {
			expect(hasFileExtension('my.folder/file')).toBe(false)
		})

		test('dot in directory name, file with extension', () => {
			expect(hasFileExtension('my.folder/index.html')).toBe(true)
		})

		test('multiple dotted directories, extensionless file', () => {
			expect(hasFileExtension('v1.0/api.v2/handler')).toBe(false)
		})

		test('multiple dotted directories, file with extension', () => {
			expect(hasFileExtension('v1.0/api.v2/handler.js')).toBe(true)
		})
	})

	describe('trailing-dot edge case', () => {
		test('trailing dot is not a file extension', () => {
			// "file." has a dot but no alphanumeric chars after it
			expect(hasFileExtension('file.')).toBe(false)
		})
	})
})
