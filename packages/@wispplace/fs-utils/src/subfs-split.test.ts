import { describe, expect, test } from 'bun:test'
import type { Directory, Entry } from '@wispplace/lexicons/types/place/wisp/fs'
import {
	estimateDirectorySize,
	findLargeDirectories,
	findSplittableDirectory,
	replaceDirectoryWithSubfs,
	splitDirectoryIntoChunks,
} from './subfs-split'

const MAX_SUBFS_SIZE = 75 * 1024

const directory = (entries: Entry[]) => ({
	$type: 'place.wisp.fs#directory' as const,
	type: 'directory' as const,
	entries,
})

const dir = (name: string, entries: Entry[]): Entry => ({ name, node: directory(entries) })

const file = (name: string): Entry => ({
	name,
	node: {
		$type: 'place.wisp.fs#file',
		type: 'file',
		blob: {
			$type: 'blob',
			ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
			mimeType: 'application/octet-stream',
			size: 39,
		},
		encoding: 'gzip',
		mimeType: 'image/svg+xml',
	} as Entry['node'],
})

const files = (count: number): Entry[] =>
	Array.from({ length: count }, (_, i) => file(`icon-${String(i).padStart(4, '0')}.svg`))

const largest = (root: Directory) => findLargeDirectories(root).sort((a, b) => b.size - a.size)[0]!

describe('findSplittableDirectory', () => {
	test('keeps a directory whose children all fit in one record', () => {
		const root = directory([dir('assets', [dir('icons', files(50)), ...files(300)])])
		expect(findSplittableDirectory(largest(root), MAX_SUBFS_SIZE).path).toBe('assets')
	})

	test('descends into an oversized subdirectory', () => {
		const root = directory([file('index.html'), dir('assets', [dir('icons', files(600)), file('app.js')])])
		const target = findSplittableDirectory(largest(root), MAX_SUBFS_SIZE)

		expect(target.path).toBe('assets/icons')
		expect(target.fileCount).toBe(600)
		// Every chunk of the chosen directory now fits, which chunking `assets`
		// could not do: its `icons` entry alone is over the limit.
		const chunks = splitDirectoryIntoChunks(target.directory, MAX_SUBFS_SIZE)
		expect(chunks.every((chunk) => estimateDirectorySize(chunk) <= MAX_SUBFS_SIZE)).toBe(true)
		expect(
			splitDirectoryIntoChunks(largest(root).directory, MAX_SUBFS_SIZE).some(
				(chunk) => estimateDirectorySize(chunk) > MAX_SUBFS_SIZE,
			),
		).toBe(true)
	})
})

describe('replaceDirectoryWithSubfs', () => {
	const uri = 'at://did:plc:test/place.wisp.subfs/site-subfs-1'

	test('replaces only the directory at the exact path', () => {
		const root = directory([dir('a', [dir('icons', files(1))]), dir('assets', [dir('icons', files(1))])])
		const replaced = replaceDirectoryWithSubfs(root, 'assets/icons', uri)

		const child = (parent: string) =>
			(replaced.entries.find((e) => e.name === parent)!.node as Directory).entries.find((e) => e.name === 'icons')!.node
		expect(child('assets')).toMatchObject({ type: 'subfs', subject: uri, flat: false })
		expect(child('a')).toMatchObject({ type: 'directory' })
	})
})
