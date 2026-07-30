import { describe, expect, it } from 'bun:test'
import { MAX_PRIVATE_SITE_FILE_COUNT } from '@wispplace/constants'
import { readPrivateSiteUpload } from './private-site-upload'

const requestFor = (form: FormData) =>
	new Request('http://localhost/api/user/private-sites', {
		method: 'POST',
		body: form,
	})

describe('readPrivateSiteUpload', () => {
	it('preserves names, relative paths, and omitted expiry', async () => {
		const form = new FormData()
		form.append('name', '  my private site  ')
		form.append('files', new File(['hello'], 'index.html', { type: 'text/html' }), 'nested/index.html')

		const upload = await readPrivateSiteUpload(requestFor(form))

		expect(upload.name).toBe('my private site')
		expect(upload.expiryMinutes).toBeUndefined()
		expect(upload.files).toHaveLength(1)
		expect(upload.files[0]?.path).toBe('nested/index.html')
		expect(new TextDecoder().decode(upload.files[0]?.bytes)).toBe('hello')
		expect(upload.files[0]?.mimeType).toStartWith('text/html')
	})

	it('preserves explicit zero expiry', async () => {
		const form = new FormData()
		form.append('name', 'forever')
		form.append('expiryMinutes', '0')
		form.append('files', new File(['hello'], 'index.html'))

		const upload = await readPrivateSiteUpload(requestFor(form))
		expect(upload.expiryMinutes).toBe(0)
	})

	it('strips the directory-picker root for editor uploads', async () => {
		const form = new FormData()
		form.append('name', 'folder upload')
		form.append('files', new File(['home'], 'index.html'), 'dist/index.html')
		form.append('files', new File(['css'], 'app.css'), 'dist/assets/app.css')

		const upload = await readPrivateSiteUpload(requestFor(form), { stripSharedRoot: true })

		expect(upload.files.map((file) => file.path)).toEqual(['index.html', 'assets/app.css'])
	})

	it('does not strip mixed roots or service-authenticated relative paths', async () => {
		const form = new FormData()
		form.append('files', new File(['home'], 'index.html'), 'index.html')
		form.append('files', new File(['css'], 'app.css'), 'assets/app.css')

		const upload = await readPrivateSiteUpload(requestFor(form), { stripSharedRoot: true })

		expect(upload.files.map((file) => file.path)).toEqual(['index.html', 'assets/app.css'])
	})

	it('rejects a non-numeric expiry', async () => {
		const form = new FormData()
		form.append('expiryMinutes', 'later')

		await expect(readPrivateSiteUpload(requestFor(form))).rejects.toEqual(
			expect.objectContaining({
				message: 'expiryMinutes must be a number',
				status: 400,
			}),
		)
	})

	it('enforces the private file-count limit', async () => {
		const form = new FormData()
		for (let index = 0; index <= MAX_PRIVATE_SITE_FILE_COUNT; index++) {
			form.append('files', new File([], `${index}.txt`))
		}

		await expect(readPrivateSiteUpload(requestFor(form))).rejects.toEqual(
			expect.objectContaining({
				message: `at most ${MAX_PRIVATE_SITE_FILE_COUNT} files are allowed`,
				status: 413,
			}),
		)
	})
})
