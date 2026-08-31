import { MAX_PRIVATE_SITE_FILE_COUNT, MAX_PRIVATE_SITE_SIZE } from '@wispplace/constants'
import { normalizeSitePath } from '@wispplace/fs-utils'
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

export interface PrivateSiteUploadOptions {
	stripSharedRoot?: boolean
}

const withoutSharedRoot = (files: UploadedPrivateFile[]): UploadedPrivateFile[] => {
	if (files.length === 0) return files

	const paths = files.map((file) => file.path.split('/'))
	const root = paths[0]?.[0]
	if (!root || paths.some((parts) => parts.length < 2 || parts[0] !== root)) return files

	return files.map((file, index) => ({ ...file, path: paths[index]!.slice(1).join('/') }))
}

const validatePrivateFilePaths = (files: UploadedPrivateFile[]): UploadedPrivateFile[] =>
	files.map((file) => {
		const path = normalizeSitePath(file.path)
		if (!path || path !== file.path) {
			throw new PrivateSiteUploadError('invalid file path', 400)
		}
		return { ...file, path }
	})

export const readPrivateSiteUpload = async (
	request: Request,
	options: PrivateSiteUploadOptions = {},
): Promise<PrivateSiteUpload> => {
	const declaredLength = Number(request.headers.get('content-length') ?? '0')
	if (declaredLength > MAX_PRIVATE_SITE_SIZE + 1024 * 1024) {
		throw new PrivateSiteUploadError(`private sites are limited to ${MAX_PRIVATE_SITE_SIZE} bytes`, 413)
	}

	let form: FormData
	try {
		form = await request.formData()
	} catch {
		throw new PrivateSiteUploadError('expected multipart/form-data body', 400)
	}

	const rawName = form.get('name')
	if (typeof rawName === 'string' && rawName.length > 4096) {
		throw new PrivateSiteUploadError('name must be at most 128 characters', 400)
	}
	const name = String(rawName ?? '').trim()
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

	const selectedFiles = options.stripSharedRoot ? withoutSharedRoot(files) : files
	return {
		name,
		expiryMinutes,
		files: validatePrivateFilePaths(selectedFiles),
	}
}
