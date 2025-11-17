import { describe, test, expect } from 'bun:test'
import {
	shouldCompressFile,
	compressFile,
	processUploadedFiles,
	createManifest,
	updateFileBlobs,
	computeCID,
	extractBlobMap,
	type UploadedFile,
	type FileUploadResult,
} from './wisp-utils'
import type { Directory } from '../lexicons/types/place/wisp/fs'
import { gunzipSync } from 'zlib'
import { BlobRef } from '@atproto/api'
import { CID } from 'multiformats/cid'

// Helper function to create a valid CID for testing
// Using a real valid CID from actual AT Protocol usage
const TEST_CID_STRING = 'bafkreid7ybejd5s2vv2j7d4aajjlmdgazguemcnuliiyfn6coxpwp2mi6y'

function createMockBlobRef(mimeType: string, size: number): BlobRef {
	// Create a properly formatted CID
	const cid = CID.parse(TEST_CID_STRING)
	return new BlobRef(cid as any, mimeType, size)
}

describe('shouldCompressFile', () => {
	test('should compress HTML files', () => {
		expect(shouldCompressFile('text/html')).toBe(true)
		expect(shouldCompressFile('text/html; charset=utf-8')).toBe(true)
	})

	test('should compress CSS files', () => {
		expect(shouldCompressFile('text/css')).toBe(true)
	})

	test('should compress JavaScript files', () => {
		expect(shouldCompressFile('text/javascript')).toBe(true)
		expect(shouldCompressFile('application/javascript')).toBe(true)
		expect(shouldCompressFile('application/x-javascript')).toBe(true)
	})

	test('should compress JSON files', () => {
		expect(shouldCompressFile('application/json')).toBe(true)
	})

	test('should compress SVG files', () => {
		expect(shouldCompressFile('image/svg+xml')).toBe(true)
	})

	test('should compress XML files', () => {
		expect(shouldCompressFile('text/xml')).toBe(true)
		expect(shouldCompressFile('application/xml')).toBe(true)
	})

	test('should compress plain text files', () => {
		expect(shouldCompressFile('text/plain')).toBe(true)
	})

	test('should NOT compress _redirects file', () => {
		expect(shouldCompressFile('text/plain', '_redirects')).toBe(false)
		expect(shouldCompressFile('text/plain', 'folder/_redirects')).toBe(false)
		expect(shouldCompressFile('application/octet-stream', '_redirects')).toBe(false)
	})

	test('should NOT compress images', () => {
		expect(shouldCompressFile('image/png')).toBe(false)
		expect(shouldCompressFile('image/jpeg')).toBe(false)
		expect(shouldCompressFile('image/jpg')).toBe(false)
		expect(shouldCompressFile('image/gif')).toBe(false)
		expect(shouldCompressFile('image/webp')).toBe(false)
	})

	test('should NOT compress videos', () => {
		expect(shouldCompressFile('video/mp4')).toBe(false)
		expect(shouldCompressFile('video/webm')).toBe(false)
	})

	test('should NOT compress already compressed formats', () => {
		expect(shouldCompressFile('application/zip')).toBe(false)
		expect(shouldCompressFile('application/gzip')).toBe(false)
		expect(shouldCompressFile('application/pdf')).toBe(false)
	})

	test('should NOT compress fonts', () => {
		expect(shouldCompressFile('font/woff')).toBe(false)
		expect(shouldCompressFile('font/woff2')).toBe(false)
		expect(shouldCompressFile('font/ttf')).toBe(false)
	})
})

describe('compressFile', () => {
	test('should compress text content', () => {
		const content = Buffer.from('Hello, World! '.repeat(100))
		const compressed = compressFile(content)

		expect(compressed.length).toBeLessThan(content.length)

		// Verify we can decompress it back
		const decompressed = gunzipSync(compressed)
		expect(decompressed.toString()).toBe(content.toString())
	})

	test('should compress HTML content significantly', () => {
		const html = `
			<!DOCTYPE html>
			<html>
				<head><title>Test</title></head>
				<body>
					${'<p>Hello World!</p>\n'.repeat(50)}
				</body>
			</html>
		`
		const content = Buffer.from(html)
		const compressed = compressFile(content)

		expect(compressed.length).toBeLessThan(content.length)
		
		// Verify decompression
		const decompressed = gunzipSync(compressed)
		expect(decompressed.toString()).toBe(html)
	})

	test('should handle empty content', () => {
		const content = Buffer.from('')
		const compressed = compressFile(content)
		const decompressed = gunzipSync(compressed)
		expect(decompressed.toString()).toBe('')
	})

	test('should produce deterministic compression', () => {
		const content = Buffer.from('Test content')
		const compressed1 = compressFile(content)
		const compressed2 = compressFile(content)
		
		expect(compressed1.toString('base64')).toBe(compressed2.toString('base64'))
	})
})

describe('processUploadedFiles', () => {
	test('should process single root-level file', () => {
		const files: UploadedFile[] = [
			{
				name: 'index.html',
				content: Buffer.from('<html></html>'),
				mimeType: 'text/html',
				size: 13,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(1)
		expect(result.directory.type).toBe('directory')
		expect(result.directory.entries).toHaveLength(1)
		expect(result.directory.entries[0].name).toBe('index.html')
		
		const node = result.directory.entries[0].node
		expect('blob' in node).toBe(true) // It's a file node
	})

	test('should process multiple root-level files', () => {
		const files: UploadedFile[] = [
			{
				name: 'index.html',
				content: Buffer.from('<html></html>'),
				mimeType: 'text/html',
				size: 13,
			},
			{
				name: 'styles.css',
				content: Buffer.from('body {}'),
				mimeType: 'text/css',
				size: 7,
			},
			{
				name: 'script.js',
				content: Buffer.from('console.log("hi")'),
				mimeType: 'application/javascript',
				size: 17,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(3)
		expect(result.directory.entries).toHaveLength(3)
		
		const names = result.directory.entries.map(e => e.name)
		expect(names).toContain('index.html')
		expect(names).toContain('styles.css')
		expect(names).toContain('script.js')
	})

	test('should process files with subdirectories', () => {
		const files: UploadedFile[] = [
			{
				name: 'dist/index.html',
				content: Buffer.from('<html></html>'),
				mimeType: 'text/html',
				size: 13,
			},
			{
				name: 'dist/css/styles.css',
				content: Buffer.from('body {}'),
				mimeType: 'text/css',
				size: 7,
			},
			{
				name: 'dist/js/app.js',
				content: Buffer.from('console.log()'),
				mimeType: 'application/javascript',
				size: 13,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(3)
		expect(result.directory.entries).toHaveLength(3) // index.html, css/, js/

		// Check root has index.html (after base folder removal)
		const indexEntry = result.directory.entries.find(e => e.name === 'index.html')
		expect(indexEntry).toBeDefined()

		// Check css directory exists
		const cssDir = result.directory.entries.find(e => e.name === 'css')
		expect(cssDir).toBeDefined()
		expect('entries' in cssDir!.node).toBe(true)
		
		if ('entries' in cssDir!.node) {
			expect(cssDir!.node.entries).toHaveLength(1)
			expect(cssDir!.node.entries[0].name).toBe('styles.css')
		}

		// Check js directory exists
		const jsDir = result.directory.entries.find(e => e.name === 'js')
		expect(jsDir).toBeDefined()
		expect('entries' in jsDir!.node).toBe(true)
	})

	test('should handle deeply nested subdirectories', () => {
		const files: UploadedFile[] = [
			{
				name: 'dist/deep/nested/folder/file.txt',
				content: Buffer.from('content'),
				mimeType: 'text/plain',
				size: 7,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(1)

		// Navigate through the directory structure (base folder removed)
		const deepDir = result.directory.entries.find(e => e.name === 'deep')
		expect(deepDir).toBeDefined()
		expect('entries' in deepDir!.node).toBe(true)

		if ('entries' in deepDir!.node) {
			const nestedDir = deepDir!.node.entries.find(e => e.name === 'nested')
			expect(nestedDir).toBeDefined()

			if (nestedDir && 'entries' in nestedDir.node) {
				const folderDir = nestedDir.node.entries.find(e => e.name === 'folder')
				expect(folderDir).toBeDefined()

				if (folderDir && 'entries' in folderDir.node) {
					expect(folderDir.node.entries).toHaveLength(1)
					expect(folderDir.node.entries[0].name).toBe('file.txt')
				}
			}
		}
	})

	test('should remove base folder name from paths', () => {
		const files: UploadedFile[] = [
			{
				name: 'dist/index.html',
				content: Buffer.from('<html></html>'),
				mimeType: 'text/html',
				size: 13,
			},
			{
				name: 'dist/css/styles.css',
				content: Buffer.from('body {}'),
				mimeType: 'text/css',
				size: 7,
			},
		]

		const result = processUploadedFiles(files)

		// After removing 'dist/', we should have index.html and css/ at root
		expect(result.directory.entries.find(e => e.name === 'index.html')).toBeDefined()
		expect(result.directory.entries.find(e => e.name === 'css')).toBeDefined()
		expect(result.directory.entries.find(e => e.name === 'dist')).toBeUndefined()
	})

	test('should handle empty file list', () => {
		const files: UploadedFile[] = []
		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(0)
		expect(result.directory.entries).toHaveLength(0)
	})

	test('should handle multiple files in same subdirectory', () => {
		const files: UploadedFile[] = [
			{
				name: 'dist/assets/image1.png',
				content: Buffer.from('png1'),
				mimeType: 'image/png',
				size: 4,
			},
			{
				name: 'dist/assets/image2.png',
				content: Buffer.from('png2'),
				mimeType: 'image/png',
				size: 4,
			},
		]

		const result = processUploadedFiles(files)

		expect(result.fileCount).toBe(2)
		
		const assetsDir = result.directory.entries.find(e => e.name === 'assets')
		expect(assetsDir).toBeDefined()
		
		if ('entries' in assetsDir!.node) {
			expect(assetsDir!.node.entries).toHaveLength(2)
			const names = assetsDir!.node.entries.map(e => e.name)
			expect(names).toContain('image1.png')
			expect(names).toContain('image2.png')
		}
	})
})

describe('createManifest', () => {
	test('should create valid manifest', () => {
		const root: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [],
		}

		const manifest = createManifest('example.com', root, 0)

		expect(manifest.$type).toBe('place.wisp.fs')
		expect(manifest.site).toBe('example.com')
		expect(manifest.root).toBe(root)
		expect(manifest.fileCount).toBe(0)
		expect(manifest.createdAt).toBeDefined()
		
		// Verify it's a valid ISO date string
		const date = new Date(manifest.createdAt)
		expect(date.toISOString()).toBe(manifest.createdAt)
	})

	test('should create manifest with file count', () => {
		const root: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [],
		}

		const manifest = createManifest('test-site', root, 42)
		
		expect(manifest.fileCount).toBe(42)
		expect(manifest.site).toBe('test-site')
	})

	test('should create manifest with populated directory', () => {
		const mockBlob = createMockBlobRef('text/html', 100)
		
		const root: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'index.html',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: mockBlob,
					},
				},
			],
		}

		const manifest = createManifest('populated-site', root, 1)
		
		expect(manifest).toBeDefined()
		expect(manifest.site).toBe('populated-site')
		expect(manifest.root.entries).toHaveLength(1)
	})
})

describe('updateFileBlobs', () => {
	test('should update single file blob at root', () => {
		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'index.html',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: undefined as any,
					},
				},
			],
		}

		const mockBlob = createMockBlobRef('text/html', 100)
		const uploadResults: FileUploadResult[] = [
			{
				hash: TEST_CID_STRING,
				blobRef: mockBlob,
				mimeType: 'text/html',
			},
		]

		const filePaths = ['index.html']

		const updated = updateFileBlobs(directory, uploadResults, filePaths)

		expect(updated.entries).toHaveLength(1)
		const fileNode = updated.entries[0].node
		
		if ('blob' in fileNode) {
			expect(fileNode.blob).toBeDefined()
			expect(fileNode.blob.mimeType).toBe('text/html')
			expect(fileNode.blob.size).toBe(100)
		} else {
			throw new Error('Expected file node')
		}
	})

	test('should update files in nested directories', () => {
		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'css',
					node: {
						$type: 'place.wisp.fs#directory',
						type: 'directory',
						entries: [
							{
								name: 'styles.css',
								node: {
									$type: 'place.wisp.fs#file',
									type: 'file',
									blob: undefined as any,
								},
							},
						],
					},
				},
			],
		}

		const mockBlob = createMockBlobRef('text/css', 50)
		const uploadResults: FileUploadResult[] = [
			{
				hash: TEST_CID_STRING,
				blobRef: mockBlob,
				mimeType: 'text/css',
				encoding: 'gzip',
			},
		]

		const filePaths = ['css/styles.css']

		const updated = updateFileBlobs(directory, uploadResults, filePaths)

		const cssDir = updated.entries[0]
		expect(cssDir.name).toBe('css')
		
		if ('entries' in cssDir.node) {
			const cssFile = cssDir.node.entries[0]
			expect(cssFile.name).toBe('styles.css')
			
			if ('blob' in cssFile.node) {
				expect(cssFile.node.blob.mimeType).toBe('text/css')
				if ('encoding' in cssFile.node) {
					expect(cssFile.node.encoding).toBe('gzip')
				}
			} else {
				throw new Error('Expected file node')
			}
		} else {
			throw new Error('Expected directory node')
		}
	})

	test('should handle normalized paths with base folder removed', () => {
		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'index.html',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: undefined as any,
					},
				},
			],
		}

		const mockBlob = createMockBlobRef('text/html', 100)
		const uploadResults: FileUploadResult[] = [
			{
				hash: TEST_CID_STRING,
				blobRef: mockBlob,
			},
		]

		// Path includes base folder that should be normalized
		const filePaths = ['dist/index.html']

		const updated = updateFileBlobs(directory, uploadResults, filePaths)

		const fileNode = updated.entries[0].node
		if ('blob' in fileNode) {
			expect(fileNode.blob).toBeDefined()
		} else {
			throw new Error('Expected file node')
		}
	})

	test('should preserve file metadata (encoding, mimeType, base64)', () => {
		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'data.json',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: undefined as any,
					},
				},
			],
		}

		const mockBlob = createMockBlobRef('application/json', 200)
		const uploadResults: FileUploadResult[] = [
			{
				hash: TEST_CID_STRING,
				blobRef: mockBlob,
				mimeType: 'application/json',
				encoding: 'gzip',
				base64: true,
			},
		]

		const filePaths = ['data.json']

		const updated = updateFileBlobs(directory, uploadResults, filePaths)

		const fileNode = updated.entries[0].node
		if ('blob' in fileNode && 'mimeType' in fileNode && 'encoding' in fileNode && 'base64' in fileNode) {
			expect(fileNode.mimeType).toBe('application/json')
			expect(fileNode.encoding).toBe('gzip')
			expect(fileNode.base64).toBe(true)
		} else {
			throw new Error('Expected file node with metadata')
		}
	})

	test('should handle multiple files at different directory levels', () => {
		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'index.html',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: undefined as any,
					},
				},
				{
					name: 'assets',
					node: {
						$type: 'place.wisp.fs#directory',
						type: 'directory',
						entries: [
							{
								name: 'logo.svg',
								node: {
									$type: 'place.wisp.fs#file',
									type: 'file',
									blob: undefined as any,
								},
							},
						],
					},
				},
			],
		}

		const htmlBlob = createMockBlobRef('text/html', 100)
		const svgBlob = createMockBlobRef('image/svg+xml', 500)
		
		const uploadResults: FileUploadResult[] = [
			{
				hash: TEST_CID_STRING,
				blobRef: htmlBlob,
			},
			{
				hash: TEST_CID_STRING,
				blobRef: svgBlob,
			},
		]

		const filePaths = ['index.html', 'assets/logo.svg']

		const updated = updateFileBlobs(directory, uploadResults, filePaths)

		// Check root file
		const indexNode = updated.entries[0].node
		if ('blob' in indexNode) {
			expect(indexNode.blob.mimeType).toBe('text/html')
		}

		// Check nested file
		const assetsDir = updated.entries[1]
		if ('entries' in assetsDir.node) {
			const logoNode = assetsDir.node.entries[0].node
			if ('blob' in logoNode) {
				expect(logoNode.blob.mimeType).toBe('image/svg+xml')
			}
		}
	})
})

describe('computeCID', () => {
	test('should compute CID for gzipped+base64 encoded content', () => {
		// This simulates the actual flow: gzip -> base64 -> compute CID
		const originalContent = Buffer.from('Hello, World!')
		const gzipped = compressFile(originalContent)
		const base64Content = Buffer.from(gzipped.toString('base64'), 'binary')

		const cid = computeCID(base64Content)

		// CID should be a valid CIDv1 string starting with 'bafkrei'
		expect(cid).toMatch(/^bafkrei[a-z0-9]+$/)
		expect(cid.length).toBeGreaterThan(10)
	})

	test('should compute deterministic CIDs for identical content', () => {
		const content = Buffer.from('Test content for CID calculation')
		const gzipped = compressFile(content)
		const base64Content = Buffer.from(gzipped.toString('base64'), 'binary')

		const cid1 = computeCID(base64Content)
		const cid2 = computeCID(base64Content)

		expect(cid1).toBe(cid2)
	})

	test('should compute different CIDs for different content', () => {
		const content1 = Buffer.from('Content A')
		const content2 = Buffer.from('Content B')

		const gzipped1 = compressFile(content1)
		const gzipped2 = compressFile(content2)

		const base64Content1 = Buffer.from(gzipped1.toString('base64'), 'binary')
		const base64Content2 = Buffer.from(gzipped2.toString('base64'), 'binary')

		const cid1 = computeCID(base64Content1)
		const cid2 = computeCID(base64Content2)

		expect(cid1).not.toBe(cid2)
	})

	test('should handle empty content', () => {
		const emptyContent = Buffer.from('')
		const gzipped = compressFile(emptyContent)
		const base64Content = Buffer.from(gzipped.toString('base64'), 'binary')

		const cid = computeCID(base64Content)

		expect(cid).toMatch(/^bafkrei[a-z0-9]+$/)
	})

	test('should compute same CID as PDS for base64-encoded content', () => {
		// Test that binary encoding produces correct bytes for CID calculation
		const testContent = Buffer.from('<!DOCTYPE html><html><body>Hello</body></html>')
		const gzipped = compressFile(testContent)
		const base64Content = Buffer.from(gzipped.toString('base64'), 'binary')

		// Compute CID twice to ensure consistency
		const cid1 = computeCID(base64Content)
		const cid2 = computeCID(base64Content)

		expect(cid1).toBe(cid2)
		expect(cid1).toMatch(/^bafkrei/)
	})

	test('should use binary encoding for base64 strings', () => {
		// This test verifies we're using the correct encoding method
		// For base64 strings, 'binary' encoding ensures each character becomes exactly one byte
		const content = Buffer.from('Test content')
		const gzipped = compressFile(content)
		const base64String = gzipped.toString('base64')

		// Using binary encoding (what we use in production)
		const base64Content = Buffer.from(base64String, 'binary')

		// Verify the length matches the base64 string length
		expect(base64Content.length).toBe(base64String.length)

		// Verify CID is computed correctly
		const cid = computeCID(base64Content)
		expect(cid).toMatch(/^bafkrei/)
	})
})

describe('extractBlobMap', () => {
	test('should extract blob map from flat directory structure', () => {
		const mockCid = CID.parse(TEST_CID_STRING)
		const mockBlob = new BlobRef(mockCid as any, 'text/html', 100)

		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'index.html',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: mockBlob,
					},
				},
			],
		}

		const blobMap = extractBlobMap(directory)

		expect(blobMap.size).toBe(1)
		expect(blobMap.has('index.html')).toBe(true)

		const entry = blobMap.get('index.html')
		expect(entry?.cid).toBe(TEST_CID_STRING)
		expect(entry?.blobRef).toBe(mockBlob)
	})

	test('should extract blob map from nested directory structure', () => {
		const mockCid1 = CID.parse(TEST_CID_STRING)
		const mockCid2 = CID.parse('bafkreiabaduc3573q6snt2xgxzpglwuaojkzflocncrh2vj5j3jykdpqhi')

		const mockBlob1 = new BlobRef(mockCid1 as any, 'text/html', 100)
		const mockBlob2 = new BlobRef(mockCid2 as any, 'text/css', 50)

		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'index.html',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: mockBlob1,
					},
				},
				{
					name: 'assets',
					node: {
						$type: 'place.wisp.fs#directory',
						type: 'directory',
						entries: [
							{
								name: 'styles.css',
								node: {
									$type: 'place.wisp.fs#file',
									type: 'file',
									blob: mockBlob2,
								},
							},
						],
					},
				},
			],
		}

		const blobMap = extractBlobMap(directory)

		expect(blobMap.size).toBe(2)
		expect(blobMap.has('index.html')).toBe(true)
		expect(blobMap.has('assets/styles.css')).toBe(true)

		expect(blobMap.get('index.html')?.cid).toBe(TEST_CID_STRING)
		expect(blobMap.get('assets/styles.css')?.cid).toBe('bafkreiabaduc3573q6snt2xgxzpglwuaojkzflocncrh2vj5j3jykdpqhi')
	})

	test('should handle deeply nested directory structures', () => {
		const mockCid = CID.parse(TEST_CID_STRING)
		const mockBlob = new BlobRef(mockCid as any, 'text/javascript', 200)

		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'src',
					node: {
						$type: 'place.wisp.fs#directory',
						type: 'directory',
						entries: [
							{
								name: 'lib',
								node: {
									$type: 'place.wisp.fs#directory',
									type: 'directory',
									entries: [
										{
											name: 'utils.js',
											node: {
												$type: 'place.wisp.fs#file',
												type: 'file',
												blob: mockBlob,
											},
										},
									],
								},
							},
						],
					},
				},
			],
		}

		const blobMap = extractBlobMap(directory)

		expect(blobMap.size).toBe(1)
		expect(blobMap.has('src/lib/utils.js')).toBe(true)
		expect(blobMap.get('src/lib/utils.js')?.cid).toBe(TEST_CID_STRING)
	})

	test('should handle empty directory', () => {
		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [],
		}

		const blobMap = extractBlobMap(directory)

		expect(blobMap.size).toBe(0)
	})

	test('should correctly extract CID from BlobRef instances (not plain objects)', () => {
		// This test verifies the fix: AT Protocol SDK returns BlobRef instances,
		// not plain objects with $type and $link properties
		const mockCid = CID.parse(TEST_CID_STRING)
		const mockBlob = new BlobRef(mockCid as any, 'application/octet-stream', 500)

		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'test.bin',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: mockBlob,
					},
				},
			],
		}

		const blobMap = extractBlobMap(directory)

		// The fix: we call .toString() on the CID instance instead of accessing $link
		expect(blobMap.get('test.bin')?.cid).toBe(TEST_CID_STRING)
		expect(blobMap.get('test.bin')?.blobRef.ref.toString()).toBe(TEST_CID_STRING)
	})

	test('should handle multiple files in same directory', () => {
		const mockCid1 = CID.parse(TEST_CID_STRING)
		const mockCid2 = CID.parse('bafkreiabaduc3573q6snt2xgxzpglwuaojkzflocncrh2vj5j3jykdpqhi')
		const mockCid3 = CID.parse('bafkreieb3ixgchss44kw7xiavnkns47emdfsqbhcdfluo3p6n3o53fl3vq')

		const mockBlob1 = new BlobRef(mockCid1 as any, 'image/png', 1000)
		const mockBlob2 = new BlobRef(mockCid2 as any, 'image/png', 2000)
		const mockBlob3 = new BlobRef(mockCid3 as any, 'image/png', 3000)

		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'images',
					node: {
						$type: 'place.wisp.fs#directory',
						type: 'directory',
						entries: [
							{
								name: 'logo.png',
								node: {
									$type: 'place.wisp.fs#file',
									type: 'file',
									blob: mockBlob1,
								},
							},
							{
								name: 'banner.png',
								node: {
									$type: 'place.wisp.fs#file',
									type: 'file',
									blob: mockBlob2,
								},
							},
							{
								name: 'icon.png',
								node: {
									$type: 'place.wisp.fs#file',
									type: 'file',
									blob: mockBlob3,
								},
							},
						],
					},
				},
			],
		}

		const blobMap = extractBlobMap(directory)

		expect(blobMap.size).toBe(3)
		expect(blobMap.has('images/logo.png')).toBe(true)
		expect(blobMap.has('images/banner.png')).toBe(true)
		expect(blobMap.has('images/icon.png')).toBe(true)
	})

	test('should handle mixed directory and file structure', () => {
		const mockCid1 = CID.parse(TEST_CID_STRING)
		const mockCid2 = CID.parse('bafkreiabaduc3573q6snt2xgxzpglwuaojkzflocncrh2vj5j3jykdpqhi')
		const mockCid3 = CID.parse('bafkreieb3ixgchss44kw7xiavnkns47emdfsqbhcdfluo3p6n3o53fl3vq')

		const directory: Directory = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'index.html',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: new BlobRef(mockCid1 as any, 'text/html', 100),
					},
				},
				{
					name: 'assets',
					node: {
						$type: 'place.wisp.fs#directory',
						type: 'directory',
						entries: [
							{
								name: 'styles.css',
								node: {
									$type: 'place.wisp.fs#file',
									type: 'file',
									blob: new BlobRef(mockCid2 as any, 'text/css', 50),
								},
							},
						],
					},
				},
				{
					name: 'README.md',
					node: {
						$type: 'place.wisp.fs#file',
						type: 'file',
						blob: new BlobRef(mockCid3 as any, 'text/markdown', 200),
					},
				},
			],
		}

		const blobMap = extractBlobMap(directory)

		expect(blobMap.size).toBe(3)
		expect(blobMap.has('index.html')).toBe(true)
		expect(blobMap.has('assets/styles.css')).toBe(true)
		expect(blobMap.has('README.md')).toBe(true)
	})
})
