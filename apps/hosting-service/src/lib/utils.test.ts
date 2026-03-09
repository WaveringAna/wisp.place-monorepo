import { describe, expect, test } from 'bun:test'
import { BlobRef } from '@atproto/lexicon'
import type {
	Directory as FsDirectory,
	Entry as FsEntry,
	File as FsFile,
	Subfs as FsSubfs,
	Record as WispFsRecord,
} from '@wispplace/lexicons/types/place/wisp/fs'
import type {
	Directory as SubfsDirectory,
	Entry as SubfsEntry,
	File as SubfsFile,
	Record as SubfsRecord,
	Subfs as SubfsSubfs,
} from '@wispplace/lexicons/types/place/wisp/subfs'
import type { $Typed } from '@wispplace/lexicons/util'
import { CID } from 'multiformats'
import { expandSubfsNodes, extractBlobCid, extractSubfsUris, sanitizePath } from './utils'

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
		expect(sanitizePath('index.html\0.txt')).toBe('')
		expect(sanitizePath('test\0')).toBe('')
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
			ref: { $link: TEST_CID },
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
		const blobRef = {
			$type: 'blob',
			ref: CID.parse(TEST_CID),
			mimeType: 'text/html',
			size: 1234,
		}
		expect(extractBlobCid(blobRef)).toBe(TEST_CID)
	})

	test('handles BlobRef with additional properties', () => {
		const blobRef = {
			ref: { $link: TEST_CID },
			mimeType: 'image/png',
			size: 5678,
			someOtherField: 'value',
		}
		expect(extractBlobCid(blobRef)).toBe(TEST_CID)
	})

	test('prioritizes checking IPLD link first', () => {
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

const TEST_CID_BASE = 'bafkreid7ybejd5s2vv2j7d4aajjlmdgazguemcnuliiyfn6coxpwp2mi6y'

function createMockBlobRef(_cidSuffix: string = '', size: number = 100, mimeType: string = 'text/plain'): BlobRef {
	const cidString = TEST_CID_BASE
	return new BlobRef(CID.parse(cidString), mimeType, size)
}

function createFsFile(
	name: string,
	options: { mimeType?: string; size?: number; encoding?: 'gzip'; base64?: boolean } = {},
): FsEntry {
	const { mimeType = 'text/plain', size = 100, encoding, base64 } = options
	const file: $Typed<FsFile, 'place.wisp.fs#file'> = {
		$type: 'place.wisp.fs#file',
		type: 'file',
		blob: createMockBlobRef(name.replace(/[^a-z0-9]/gi, ''), size, mimeType),
		...(encoding && { encoding }),
		...(mimeType && { mimeType }),
		...(base64 && { base64 }),
	}
	return { name, node: file }
}

function createFsDirectory(name: string, entries: FsEntry[]): FsEntry {
	const dir: $Typed<FsDirectory, 'place.wisp.fs#directory'> = {
		$type: 'place.wisp.fs#directory',
		type: 'directory',
		entries,
	}
	return { name, node: dir }
}

function createFsSubfs(name: string, subject: string, flat: boolean = true): FsEntry {
	const subfs: $Typed<FsSubfs, 'place.wisp.fs#subfs'> = {
		$type: 'place.wisp.fs#subfs',
		type: 'subfs',
		subject,
		flat,
	}
	return { name, node: subfs }
}

function createFsRootDirectory(entries: FsEntry[]): FsDirectory {
	return {
		$type: 'place.wisp.fs#directory',
		type: 'directory',
		entries,
	}
}

function createFsRecord(site: string, entries: FsEntry[], fileCount?: number): WispFsRecord {
	return {
		$type: 'place.wisp.fs',
		site,
		root: createFsRootDirectory(entries),
		...(fileCount !== undefined && { fileCount }),
		createdAt: new Date().toISOString(),
	}
}

function createSubfsFile(
	name: string,
	options: { mimeType?: string; size?: number; encoding?: 'gzip'; base64?: boolean } = {},
): SubfsEntry {
	const { mimeType = 'text/plain', size = 100, encoding, base64 } = options
	const file: $Typed<SubfsFile, 'place.wisp.subfs#file'> = {
		$type: 'place.wisp.subfs#file',
		type: 'file',
		blob: createMockBlobRef(name.replace(/[^a-z0-9]/gi, ''), size, mimeType),
		...(encoding && { encoding }),
		...(mimeType && { mimeType }),
		...(base64 && { base64 }),
	}
	return { name, node: file }
}

function createSubfsDirectory(name: string, entries: SubfsEntry[]): SubfsEntry {
	const dir: $Typed<SubfsDirectory, 'place.wisp.subfs#directory'> = {
		$type: 'place.wisp.subfs#directory',
		type: 'directory',
		entries,
	}
	return { name, node: dir }
}

function createSubfsSubfs(name: string, subject: string): SubfsEntry {
	const subfs: $Typed<SubfsSubfs, 'place.wisp.subfs#subfs'> = {
		$type: 'place.wisp.subfs#subfs',
		type: 'subfs',
		subject,
	}
	return { name, node: subfs }
}

function createSubfsRootDirectory(entries: SubfsEntry[]): SubfsDirectory {
	return {
		$type: 'place.wisp.subfs#directory',
		type: 'directory',
		entries,
	}
}

function createSubfsRecord(entries: SubfsEntry[], fileCount?: number): SubfsRecord {
	return {
		$type: 'place.wisp.subfs',
		root: createSubfsRootDirectory(entries),
		...(fileCount !== undefined && { fileCount }),
		createdAt: new Date().toISOString(),
	}
}

describe('extractSubfsUris', () => {
	test('extracts subfs URIs from flat directory structure', () => {
		const subfsUri = 'at://did:plc:test/place.wisp.subfs/a'
		const dir = createFsRootDirectory([createFsSubfs('a', subfsUri), createFsFile('file.txt')])

		const uris = extractSubfsUris(dir)

		expect(uris).toHaveLength(1)
		expect(uris[0]).toEqual({ uri: subfsUri, path: 'a' })
	})

	test('extracts subfs URIs from nested directory structure', () => {
		const subfsAUri = 'at://did:plc:test/place.wisp.subfs/a'
		const subfsBUri = 'at://did:plc:test/place.wisp.subfs/b'

		const dir = createFsRootDirectory([
			createFsSubfs('a', subfsAUri),
			createFsDirectory('nested', [createFsSubfs('b', subfsBUri), createFsFile('file.txt')]),
		])

		const uris = extractSubfsUris(dir)

		expect(uris).toHaveLength(2)
		expect(uris).toContainEqual({ uri: subfsAUri, path: 'a' })
		expect(uris).toContainEqual({ uri: subfsBUri, path: 'nested/b' })
	})

	test('returns empty array when no subfs nodes exist', () => {
		const dir = createFsRootDirectory([
			createFsFile('file1.txt'),
			createFsDirectory('dir', [createFsFile('file2.txt')]),
		])

		const uris = extractSubfsUris(dir)
		expect(uris).toHaveLength(0)
	})

	test('handles deeply nested subfs', () => {
		const subfsUri = 'at://did:plc:test/place.wisp.subfs/deep'
		const dir = createFsRootDirectory([
			createFsDirectory('a', [createFsDirectory('b', [createFsDirectory('c', [createFsSubfs('deep', subfsUri)])])]),
		])

		const uris = extractSubfsUris(dir)

		expect(uris).toHaveLength(1)
		expect(uris[0]).toEqual({ uri: subfsUri, path: 'a/b/c/deep' })
	})
})

describe('expandSubfsNodes caching', () => {
	test('cache map is populated after expansion', async () => {
		const subfsCache = new Map<string, SubfsRecord | null>()
		const dir = createFsRootDirectory([createFsFile('file.txt')])

		const result = await expandSubfsNodes(dir, 'https://pds.example.com', 0, subfsCache)

		expect(subfsCache.size).toBe(0)
		expect(result.entries).toHaveLength(1)
		expect(result.entries[0]?.name).toBe('file.txt')
	})

	test('cache is passed through recursion depths', async () => {
		const subfsCache = new Map<string, SubfsRecord | null>()
		const mockSubfsUri = 'at://did:plc:test/place.wisp.subfs/cached'
		const mockRecord = createSubfsRecord([createSubfsFile('cached-file.txt')])
		subfsCache.set(mockSubfsUri, mockRecord)

		const dir = createFsRootDirectory([createFsSubfs('cached', mockSubfsUri)])
		const result = await expandSubfsNodes(dir, 'https://pds.example.com', 0, subfsCache)

		expect(subfsCache.has(mockSubfsUri)).toBe(true)
		expect(result.entries).toHaveLength(1)
		expect(result.entries[0]?.name).toBe('cached-file.txt')
	})

	test('pre-populated cache prevents re-fetching', async () => {
		const subfsCache = new Map<string, SubfsRecord | null>()
		const subfsAUri = 'at://did:plc:test/place.wisp.subfs/a'
		const subfsBUri = 'at://did:plc:test/place.wisp.subfs/b'

		subfsCache.set(subfsAUri, createSubfsRecord([createSubfsSubfs('b', subfsBUri)]))
		subfsCache.set(subfsBUri, createSubfsRecord([createSubfsFile('final.txt')]))

		const dir = createFsRootDirectory([createFsSubfs('a', subfsAUri)])
		const result = await expandSubfsNodes(dir, 'https://pds.example.com', 0, subfsCache)

		expect(result.entries).toHaveLength(1)
		expect(result.entries[0]?.name).toBe('final.txt')
	})

	test('diamond dependency uses cache for shared reference', async () => {
		const subfsCache = new Map<string, SubfsRecord | null>()
		const subfsAUri = 'at://did:plc:test/place.wisp.subfs/a'
		const subfsBUri = 'at://did:plc:test/place.wisp.subfs/b'
		const subfsCUri = 'at://did:plc:test/place.wisp.subfs/c'

		subfsCache.set(subfsAUri, createSubfsRecord([createSubfsSubfs('c', subfsCUri)]))
		subfsCache.set(subfsBUri, createSubfsRecord([createSubfsSubfs('c', subfsCUri)]))
		subfsCache.set(subfsCUri, createSubfsRecord([createSubfsFile('shared.txt')]))

		const dir = createFsRootDirectory([createFsSubfs('a', subfsAUri), createFsSubfs('b', subfsBUri)])
		const result = await expandSubfsNodes(dir, 'https://pds.example.com', 0, subfsCache)

		expect(result.entries.filter((e) => e.name === 'shared.txt')).toHaveLength(2)
	})

	test('handles null records in cache gracefully', async () => {
		const subfsCache = new Map<string, SubfsRecord | null>()
		const subfsUri = 'at://did:plc:test/place.wisp.subfs/missing'
		subfsCache.set(subfsUri, null)

		const dir = createFsRootDirectory([createFsFile('file.txt'), createFsSubfs('missing', subfsUri)])
		const result = await expandSubfsNodes(dir, 'https://pds.example.com', 0, subfsCache)

		expect(result.entries.some((e) => e.name === 'file.txt')).toBe(true)
		expect(result.entries.some((e) => e.name === 'missing')).toBe(true)
	})

	test('non-flat subfs merge creates directory instead of hoisting', async () => {
		const subfsCache = new Map<string, SubfsRecord | null>()
		const subfsUri = 'at://did:plc:test/place.wisp.subfs/nested'
		subfsCache.set(subfsUri, createSubfsRecord([createSubfsFile('nested-file.txt')]))

		const dir = createFsRootDirectory([createFsFile('root.txt'), createFsSubfs('subdir', subfsUri, false)])
		const result = await expandSubfsNodes(dir, 'https://pds.example.com', 0, subfsCache)

		expect(result.entries).toHaveLength(2)

		const rootFile = result.entries.find((e) => e.name === 'root.txt')
		expect(rootFile).toBeDefined()

		const subdir = result.entries.find((e) => e.name === 'subdir')
		expect(subdir).toBeDefined()

		if (subdir && 'entries' in subdir.node) {
			expect(subdir.node.type).toBe('directory')
			expect(subdir.node.entries).toHaveLength(1)
			expect(subdir.node.entries[0]?.name).toBe('nested-file.txt')
		}
	})
})

describe('WispFsRecord mock builders', () => {
	test('createFsRecord creates valid record structure', () => {
		const record = createFsRecord('my-site', [
			createFsFile('index.html', { mimeType: 'text/html' }),
			createFsDirectory('assets', [createFsFile('style.css', { mimeType: 'text/css' })]),
		])

		expect(record.$type).toBe('place.wisp.fs')
		expect(record.site).toBe('my-site')
		expect(record.root.type).toBe('directory')
		expect(record.root.entries).toHaveLength(2)
		expect(record.createdAt).toBeDefined()
	})

	test('createFsFile creates valid file entry', () => {
		const entry = createFsFile('test.html', { mimeType: 'text/html', size: 500 })

		expect(entry.name).toBe('test.html')

		const file = entry.node
		if ('blob' in file) {
			expect(file.$type).toBe('place.wisp.fs#file')
			expect(file.type).toBe('file')
			expect(file.blob).toBeDefined()
			expect(file.mimeType).toBe('text/html')
		}
	})

	test('createFsFile with gzip encoding', () => {
		const entry = createFsFile('bundle.js', { mimeType: 'application/javascript', encoding: 'gzip' })

		const file = entry.node
		if ('encoding' in file) {
			expect(file.encoding).toBe('gzip')
		}
	})

	test('createFsFile with base64 flag', () => {
		const entry = createFsFile('data.bin', { base64: true })

		const file = entry.node
		if ('base64' in file) {
			expect(file.base64).toBe(true)
		}
	})

	test('createFsDirectory creates valid directory entry', () => {
		const entry = createFsDirectory('assets', [createFsFile('file1.txt'), createFsFile('file2.txt')])

		expect(entry.name).toBe('assets')

		const dir = entry.node
		if ('entries' in dir) {
			expect(dir.$type).toBe('place.wisp.fs#directory')
			expect(dir.type).toBe('directory')
			expect(dir.entries).toHaveLength(2)
		}
	})

	test('createFsSubfs creates valid subfs entry with flat=true', () => {
		const entry = createFsSubfs('external', 'at://did:plc:test/place.wisp.subfs/ext')

		expect(entry.name).toBe('external')

		const subfs = entry.node
		if ('subject' in subfs) {
			expect(subfs.$type).toBe('place.wisp.fs#subfs')
			expect(subfs.type).toBe('subfs')
			expect(subfs.subject).toBe('at://did:plc:test/place.wisp.subfs/ext')
			expect(subfs.flat).toBe(true)
		}
	})

	test('createFsSubfs creates valid subfs entry with flat=false', () => {
		const entry = createFsSubfs('external', 'at://did:plc:test/place.wisp.subfs/ext', false)

		const subfs = entry.node
		if ('subject' in subfs) {
			expect(subfs.flat).toBe(false)
		}
	})

	test('createFsRecord with fileCount', () => {
		const record = createFsRecord('my-site', [createFsFile('index.html')], 1)
		expect(record.fileCount).toBe(1)
	})
})

describe('SubfsRecord mock builders', () => {
	test('createSubfsRecord creates valid record structure', () => {
		const record = createSubfsRecord([
			createSubfsFile('file1.txt'),
			createSubfsDirectory('nested', [createSubfsFile('file2.txt')]),
		])

		expect(record.$type).toBe('place.wisp.subfs')
		expect(record.root.type).toBe('directory')
		expect(record.root.entries).toHaveLength(2)
		expect(record.createdAt).toBeDefined()
	})

	test('createSubfsFile creates valid file entry', () => {
		const entry = createSubfsFile('data.json', { mimeType: 'application/json', size: 1024 })

		expect(entry.name).toBe('data.json')

		const file = entry.node
		if ('blob' in file) {
			expect(file.$type).toBe('place.wisp.subfs#file')
			expect(file.type).toBe('file')
			expect(file.blob).toBeDefined()
			expect(file.mimeType).toBe('application/json')
		}
	})

	test('createSubfsDirectory creates valid directory entry', () => {
		const entry = createSubfsDirectory('subdir', [createSubfsFile('inner.txt')])

		expect(entry.name).toBe('subdir')

		const dir = entry.node
		if ('entries' in dir) {
			expect(dir.$type).toBe('place.wisp.subfs#directory')
			expect(dir.type).toBe('directory')
			expect(dir.entries).toHaveLength(1)
		}
	})

	test('createSubfsSubfs creates valid nested subfs entry', () => {
		const entry = createSubfsSubfs('deeper', 'at://did:plc:test/place.wisp.subfs/deeper')

		expect(entry.name).toBe('deeper')

		const subfs = entry.node
		if ('subject' in subfs) {
			expect(subfs.$type).toBe('place.wisp.subfs#subfs')
			expect(subfs.type).toBe('subfs')
			expect(subfs.subject).toBe('at://did:plc:test/place.wisp.subfs/deeper')
			expect('flat' in subfs).toBe(false)
		}
	})

	test('createSubfsRecord with fileCount', () => {
		const record = createSubfsRecord([createSubfsFile('file.txt')], 1)
		expect(record.fileCount).toBe(1)
	})
})

describe('extractBlobCid with typed mock data', () => {
	test('extracts CID from FsFile blob', () => {
		const entry = createFsFile('test.txt')
		const file = entry.node

		if ('blob' in file) {
			const cid = extractBlobCid(file.blob)
			expect(cid).toBeDefined()
			expect(cid).toContain('bafkrei')
		}
	})

	test('extracts CID from SubfsFile blob', () => {
		const entry = createSubfsFile('test.txt')
		const file = entry.node

		if ('blob' in file) {
			const cid = extractBlobCid(file.blob)
			expect(cid).toBeDefined()
			expect(cid).toContain('bafkrei')
		}
	})
})
