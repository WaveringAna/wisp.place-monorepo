/**
 * Transport-level parsing for private-site multipart uploads.
 *
 * Both the cookie-authenticated editor route and the service-authenticated XRPC route
 * use this parser, then hand the resulting files to the same ingestion service. Auth is
 * deliberately absent here so upload mechanics cannot make access decisions.
 */

import { MAX_PRIVATE_SITE_FILE_COUNT, MAX_PRIVATE_SITE_SIZE } from '@wispplace/constants'
import type { UploadedPrivateFile } from './private-sites-service'

export class PrivateSiteUploadError extends Error {
	constructor(
		message: string,
		public readonly status: 400 | 413,
	) {
		super(message)
		this.name = 'PrivateSiteUploadError'
	}
}

const parseExpiryMinutes = (raw: FormDataEntryValue | null): number | null | undefined => {
	if (raw === null || raw === '') return undefined
	if (typeof raw !== 'string') {
		throw new PrivateSiteUploadError('expiryMinutes must be a number', 400)
	}

	const value = Number(raw)
	if (!Number.isFinite(value)) {
		throw new PrivateSiteUploadError('expiryMinutes must be a number', 400)
	}
	return value
}

export interface PrivateSiteUpload {
	name: string
	expiryMinutes: number | null | undefined
	files: UploadedPrivateFile[]
}

export const readPrivateSiteUpload = async (request: Request): Promise<PrivateSiteUpload> => {
	let form: FormData
	try {
		form = await request.formData()
	} catch {
		throw new PrivateSiteUploadError('expected multipart/form-data body', 400)
	}

	const name = String(form.get('name') ?? '').trim()
	const expiryMinutes = parseExpiryMinutes(form.get('expiryMinutes'))
	const files: UploadedPrivateFile[] = []
	let totalBytes = 0

	for (const [field, value] of form.entries()) {
		if (field !== 'files' && field !== 'file') continue
		if (typeof value === 'string') continue
		const file = value as File

		if (files.length >= MAX_PRIVATE_SITE_FILE_COUNT) {
			throw new PrivateSiteUploadError(`at most ${MAX_PRIVATE_SITE_FILE_COUNT} files are allowed`, 413)
		}

		totalBytes += file.size
		if (totalBytes > MAX_PRIVATE_SITE_SIZE) {
			throw new PrivateSiteUploadError(`private sites are limited to ${MAX_PRIVATE_SITE_SIZE} bytes`, 413)
		}

		files.push({
			path: file.name,
			bytes: new Uint8Array(await file.arrayBuffer()),
			mimeType: file.type || null,
		})
	}

	return { name, expiryMinutes, files }
}
