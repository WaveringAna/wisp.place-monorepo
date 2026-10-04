import { describe, expect, test } from 'bun:test'
import { hitPdsSizeLimit, idleUpload, phaseText, RECENT_FILES, uploadReducer } from './upload-progress'

describe('upload progress', () => {
	const started = uploadReducer(idleUpload, { type: 'start', title: 'deploy blog' })
	const file = (name: string, status: 'uploading' | 'uploaded') =>
		({ type: 'progress', progress: { phase: 'uploading', currentFile: name, currentFileStatus: status } }) as const

	test('describes each server phase', () => {
		expect(phaseText({ phase: 'uploading', filesUploaded: 2, filesReused: 1, totalFiles: 5 })).toBe(
			'uploading to your pds 3/5',
		)
		expect(phaseText({ phase: 'creating_manifest' })).toBe('writing the manifest')
		expect(phaseText({})).toBe('working')
	})

	test('keeps a short tail of files, updating a file in place', () => {
		const once = uploadReducer(uploadReducer(started, file('a.html', 'uploading')), file('a.html', 'uploaded'))
		expect(once.recent).toEqual([{ name: 'a.html', status: 'uploaded' }])

		const many = Array.from({ length: RECENT_FILES + 3 }, (_, index) => file(`f${index}`, 'uploaded')).reduce(
			uploadReducer,
			started,
		)
		expect(many.recent).toHaveLength(RECENT_FILES)
		expect(many.recent[many.recent.length - 1]?.name).toBe(`f${RECENT_FILES + 2}`)
	})

	test('finishes or fails without losing the title', () => {
		expect(uploadReducer(started, { type: 'done', result: { fileCount: 3 } })).toMatchObject({
			title: 'deploy blog',
			running: false,
			result: { fileCount: 3 },
		})
		expect(uploadReducer(started, { type: 'fail', error: 'nope' })).toMatchObject({ running: false, error: 'nope' })
	})

	test('spots pds size rejections in file errors', () => {
		expect(hitPdsSizeLimit({ failedFiles: [{ name: 'a.mp4', error: '413 Request Entity Too Large' }] })).toBe(true)
		expect(hitPdsSizeLimit({ failedFiles: [{ name: 'a.mp4', error: 'timeout' }] })).toBe(false)
	})
})
