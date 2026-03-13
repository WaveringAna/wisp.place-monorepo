import { describe, expect, test } from 'bun:test'
import { matchGlob } from '../src/utils/glob.js'

describe('matchGlob', () => {
	describe('exact matches', () => {
		test('should match exact strings', () => {
			expect(matchGlob('index.html', 'index.html')).toBe(true)
			expect(matchGlob('index.html', 'about.html')).toBe(false)
		})

		test('should match paths exactly', () => {
			expect(matchGlob('site/index.html', 'site/index.html')).toBe(true)
			expect(matchGlob('site/index.html', 'other/index.html')).toBe(false)
		})
	})

	describe('* wildcard', () => {
		test('should match any characters except /', () => {
			expect(matchGlob('*.html', 'index.html')).toBe(true)
			expect(matchGlob('*.html', 'about.html')).toBe(true)
			expect(matchGlob('*.html', 'style.css')).toBe(false)
		})

		test('should not match across path separators', () => {
			expect(matchGlob('*.html', 'dir/index.html')).toBe(false)
		})

		test('should work with prefix and suffix', () => {
			expect(matchGlob('index.*', 'index.html')).toBe(true)
			expect(matchGlob('index.*', 'index.css')).toBe(true)
			expect(matchGlob('index.*', 'about.html')).toBe(false)
		})
	})

	describe('** wildcard', () => {
		test('should match any characters including /', () => {
			expect(matchGlob('**', 'anything')).toBe(true)
			expect(matchGlob('**', 'path/to/file.txt')).toBe(true)
		})

		test('should match deeply nested paths', () => {
			expect(matchGlob('**/index.html', 'index.html')).toBe(true)
			expect(matchGlob('**/index.html', 'site/index.html')).toBe(true)
			expect(matchGlob('**/index.html', 'a/b/c/index.html')).toBe(true)
			expect(matchGlob('**/index.html', 'a/b/c/about.html')).toBe(false)
		})

		test('should match directory prefixes', () => {
			expect(matchGlob('assets/**', 'assets/style.css')).toBe(true)
			expect(matchGlob('assets/**', 'assets/images/logo.png')).toBe(true)
			expect(matchGlob('assets/**', 'other/style.css')).toBe(false)
		})

		test('should match in the middle of a path', () => {
			expect(matchGlob('site/**/index.html', 'site/index.html')).toBe(true)
			expect(matchGlob('site/**/index.html', 'site/pages/index.html')).toBe(true)
			expect(matchGlob('site/**/index.html', 'site/a/b/c/index.html')).toBe(true)
		})
	})

	describe('{a,b,c} alternation', () => {
		test('should match any of the alternatives', () => {
			expect(matchGlob('*.{html,css,js}', 'index.html')).toBe(true)
			expect(matchGlob('*.{html,css,js}', 'style.css')).toBe(true)
			expect(matchGlob('*.{html,css,js}', 'app.js')).toBe(true)
			expect(matchGlob('*.{html,css,js}', 'image.png')).toBe(false)
		})

		test('should work with ** and alternation', () => {
			expect(matchGlob('**/*.{jpg,png,gif}', 'logo.png')).toBe(true)
			expect(matchGlob('**/*.{jpg,png,gif}', 'images/logo.png')).toBe(true)
			expect(matchGlob('**/*.{jpg,png,gif}', 'a/b/photo.jpg')).toBe(true)
			expect(matchGlob('**/*.{jpg,png,gif}', 'style.css')).toBe(false)
		})
	})

	describe('edge cases', () => {
		test('should handle empty strings', () => {
			expect(matchGlob('', '')).toBe(true)
			expect(matchGlob('', 'something')).toBe(false)
			expect(matchGlob('**', '')).toBe(true)
		})

		test('should escape regex special characters', () => {
			expect(matchGlob('file.txt', 'file.txt')).toBe(true)
			expect(matchGlob('file.txt', 'filextxt')).toBe(false)
			expect(matchGlob('file[1].txt', 'file[1].txt')).toBe(true)
		})

		test('should handle keys with colons (common in storage)', () => {
			expect(matchGlob('site:*/index.html', 'site:abc/index.html')).toBe(true)
			expect(matchGlob('site:**/index.html', 'site:abc/pages/index.html')).toBe(true)
		})
	})
})
