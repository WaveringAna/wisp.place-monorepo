import { describe, expect, test } from 'bun:test'
import { rootedUploadPaths, uploadRoot } from './upload-paths'

describe('rootedUploadPaths', () => {
	test('keeps individually selected files at the site root', () => {
		expect(rootedUploadPaths([{ name: 'index.html' }, { name: 'index.css' }])).toEqual(['index.html', 'index.css'])
	})

	test('removes the selected directory while preserving its contents', () => {
		expect(
			rootedUploadPaths([
				{ name: 'index.html', webkitRelativePath: 'bsky-nsfw/index.html' },
				{ name: 'index.css', webkitRelativePath: 'bsky-nsfw/assets/index.css' },
			]),
		).toEqual(['index.html', 'assets/index.css'])
	})

	test('keeps distinct dropped roots when no single directory contains every file', () => {
		expect(rootedUploadPaths([{ name: 'first/index.html' }, { name: 'second/index.html' }])).toEqual([
			'first/index.html',
			'second/index.html',
		])
	})
})

describe('uploadRoot', () => {
	test('names the folder a picked directory came from', () => {
		expect(
			uploadRoot([
				{ name: 'index.html', webkitRelativePath: 'zine/index.html' },
				{ name: 'cat.png', webkitRelativePath: 'zine/img/cat.png' },
			]),
		).toBe('zine')
	})

	test('is null for loose files or several dropped roots', () => {
		expect(uploadRoot([{ name: 'index.html' }])).toBeNull()
		expect(uploadRoot([{ name: 'first/index.html' }, { name: 'second/index.html' }])).toBeNull()
	})
})
