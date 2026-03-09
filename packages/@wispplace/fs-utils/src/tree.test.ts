import { describe, expect, test } from 'bun:test'
import { processUploadedFiles, type UploadedFile } from './tree'

describe('processUploadedFiles', () => {
	test('should preserve nested directory structure', () => {
		const files: UploadedFile[] = [
			{
				name: 'mysite/index.html',
				content: Buffer.from('<html>'),
				mimeType: 'text/html',
				size: 6,
			},
			{
				name: 'mysite/_astro/main.js',
				content: Buffer.from('console.log()'),
				mimeType: 'application/javascript',
				size: 13,
			},
			{
				name: 'mysite/_astro/styles.css',
				content: Buffer.from('body {}'),
				mimeType: 'text/css',
				size: 7,
			},
			{
				name: 'mysite/images/logo.png',
				content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
				mimeType: 'image/png',
				size: 4,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(4)
		expect(result.directory.entries).toHaveLength(3) // index.html, _astro/, images/

		// Check _astro directory exists
		const astroEntry = result.directory.entries.find((e) => e.name === '_astro')
		expect(astroEntry).toBeTruthy()
		expect('type' in astroEntry!.node && astroEntry!.node.type).toBe('directory')

		if ('entries' in astroEntry!.node) {
			const astroDir = astroEntry!.node
			expect(astroDir.entries).toHaveLength(2) // main.js, styles.css
			expect(astroDir.entries.find((e) => e.name === 'main.js')).toBeTruthy()
			expect(astroDir.entries.find((e) => e.name === 'styles.css')).toBeTruthy()
		}

		// Check images directory exists
		const imagesEntry = result.directory.entries.find((e) => e.name === 'images')
		expect(imagesEntry).toBeTruthy()
		expect('type' in imagesEntry!.node && imagesEntry!.node.type).toBe('directory')

		if ('entries' in imagesEntry!.node) {
			const imagesDir = imagesEntry!.node
			expect(imagesDir.entries).toHaveLength(1) // logo.png
			expect(imagesDir.entries.find((e) => e.name === 'logo.png')).toBeTruthy()
		}
	})

	test('should handle deeply nested directories', () => {
		const files: UploadedFile[] = [
			{
				name: 'site/a/b/c/d/deep.txt',
				content: Buffer.from('deep'),
				mimeType: 'text/plain',
				size: 4,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(1)

		// Navigate through nested structure
		const aEntry = result.directory.entries.find((e) => e.name === 'a')
		expect(aEntry).toBeTruthy()
		expect('type' in aEntry!.node && aEntry!.node.type).toBe('directory')

		if ('entries' in aEntry!.node) {
			const bEntry = aEntry!.node.entries.find((e) => e.name === 'b')
			expect(bEntry).toBeTruthy()
			expect('type' in bEntry!.node && bEntry!.node.type).toBe('directory')

			if ('entries' in bEntry!.node) {
				const cEntry = bEntry!.node.entries.find((e) => e.name === 'c')
				expect(cEntry).toBeTruthy()
				expect('type' in cEntry!.node && cEntry!.node.type).toBe('directory')

				if ('entries' in cEntry!.node) {
					const dEntry = cEntry!.node.entries.find((e) => e.name === 'd')
					expect(dEntry).toBeTruthy()
					expect('type' in dEntry!.node && dEntry!.node.type).toBe('directory')

					if ('entries' in dEntry!.node) {
						const fileEntry = dEntry!.node.entries.find((e) => e.name === 'deep.txt')
						expect(fileEntry).toBeTruthy()
						expect('type' in fileEntry!.node && fileEntry!.node.type).toBe('file')
					}
				}
			}
		}
	})

	test('should handle files at root level', () => {
		const files: UploadedFile[] = [
			{
				name: 'mysite/index.html',
				content: Buffer.from('<html>'),
				mimeType: 'text/html',
				size: 6,
			},
			{
				name: 'mysite/robots.txt',
				content: Buffer.from('User-agent: *'),
				mimeType: 'text/plain',
				size: 13,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(2)
		expect(result.directory.entries).toHaveLength(2)
		expect(result.directory.entries.find((e) => e.name === 'index.html')).toBeTruthy()
		expect(result.directory.entries.find((e) => e.name === 'robots.txt')).toBeTruthy()
	})

	test('should skip .git directories', () => {
		const files: UploadedFile[] = [
			{
				name: 'mysite/index.html',
				content: Buffer.from('<html>'),
				mimeType: 'text/html',
				size: 6,
			},
			{
				name: 'mysite/.git/config',
				content: Buffer.from('[core]'),
				mimeType: 'text/plain',
				size: 6,
			},
			{
				name: 'mysite/.gitignore',
				content: Buffer.from('node_modules'),
				mimeType: 'text/plain',
				size: 12,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(2) // Only index.html and .gitignore
		expect(result.directory.entries).toHaveLength(2)
		expect(result.directory.entries.find((e) => e.name === 'index.html')).toBeTruthy()
		expect(result.directory.entries.find((e) => e.name === '.gitignore')).toBeTruthy()
		expect(result.directory.entries.find((e) => e.name === '.git')).toBeFalsy()
	})

	test('should handle mixed root and nested files', () => {
		const files: UploadedFile[] = [
			{
				name: 'mysite/index.html',
				content: Buffer.from('<html>'),
				mimeType: 'text/html',
				size: 6,
			},
			{
				name: 'mysite/about/index.html',
				content: Buffer.from('<html>'),
				mimeType: 'text/html',
				size: 6,
			},
			{
				name: 'mysite/about/team.html',
				content: Buffer.from('<html>'),
				mimeType: 'text/html',
				size: 6,
			},
			{
				name: 'mysite/robots.txt',
				content: Buffer.from('User-agent: *'),
				mimeType: 'text/plain',
				size: 13,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(4)
		expect(result.directory.entries).toHaveLength(3) // index.html, about/, robots.txt

		const aboutEntry = result.directory.entries.find((e) => e.name === 'about')
		expect(aboutEntry).toBeTruthy()
		expect('type' in aboutEntry!.node && aboutEntry!.node.type).toBe('directory')

		if ('entries' in aboutEntry!.node) {
			const aboutDir = aboutEntry!.node
			expect(aboutDir.entries).toHaveLength(2) // index.html, team.html
			expect(aboutDir.entries.find((e) => e.name === 'index.html')).toBeTruthy()
			expect(aboutDir.entries.find((e) => e.name === 'team.html')).toBeTruthy()
		}
	})

	test('should handle empty file array', () => {
		const files: UploadedFile[] = []

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(0)
		expect(result.directory.entries).toHaveLength(0)
	})

	test('should strip base folder name from paths', () => {
		// This tests the behavior where file.name includes the base folder
		// e.g., "mysite/index.html" should become "index.html" at root
		const files: UploadedFile[] = [
			{
				name: 'build-output/index.html',
				content: Buffer.from('<html>'),
				mimeType: 'text/html',
				size: 6,
			},
			{
				name: 'build-output/assets/main.js',
				content: Buffer.from('console.log()'),
				mimeType: 'application/javascript',
				size: 13,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(2)

		// Should have index.html at root and assets/ directory
		expect(result.directory.entries.find((e) => e.name === 'index.html')).toBeTruthy()
		expect(result.directory.entries.find((e) => e.name === 'assets')).toBeTruthy()

		// Should NOT have 'build-output' directory
		expect(result.directory.entries.find((e) => e.name === 'build-output')).toBeFalsy()
	})

	test('should preserve full paths with skipNormalization option (CLI use case)', () => {
		// CLI passes paths already relative to site directory, without a folder prefix
		const files: UploadedFile[] = [
			{
				name: 'index.html',
				content: Buffer.from('<html>'),
				mimeType: 'text/html',
				size: 6,
			},
			{
				name: 'assets/readme.txt',
				content: Buffer.from('readme'),
				mimeType: 'text/plain',
				size: 6,
			},
			{
				name: 'assets/images/logo.txt',
				content: Buffer.from('logo'),
				mimeType: 'text/plain',
				size: 4,
			},
			{
				name: 'assets/scripts/main.js',
				content: Buffer.from('console.log()'),
				mimeType: 'application/javascript',
				size: 13,
			},
		]

		const result = processUploadedFiles(files, { skipNormalization: true })

		expect(result.fileCount).toBe(4)

		// index.html at root
		expect(result.directory.entries.find((e) => e.name === 'index.html')).toBeTruthy()

		// assets directory should exist (NOT be stripped)
		const assetsEntry = result.directory.entries.find((e) => e.name === 'assets')
		expect(assetsEntry).toBeTruthy()
		expect('type' in assetsEntry!.node && assetsEntry!.node.type).toBe('directory')

		if ('entries' in assetsEntry!.node) {
			const assetsDir = assetsEntry!.node
			// Should have readme.txt, images/, scripts/
			expect(assetsDir.entries.find((e) => e.name === 'readme.txt')).toBeTruthy()
			expect(assetsDir.entries.find((e) => e.name === 'images')).toBeTruthy()
			expect(assetsDir.entries.find((e) => e.name === 'scripts')).toBeTruthy()

			// Check nested directories have files
			const imagesEntry = assetsDir.entries.find((e) => e.name === 'images')
			if (imagesEntry && 'entries' in imagesEntry.node) {
				expect(imagesEntry.node.entries.find((e) => e.name === 'logo.txt')).toBeTruthy()
			}

			const scriptsEntry = assetsDir.entries.find((e) => e.name === 'scripts')
			if (scriptsEntry && 'entries' in scriptsEntry.node) {
				expect(scriptsEntry.node.entries.find((e) => e.name === 'main.js')).toBeTruthy()
			}
		}
	})
})
