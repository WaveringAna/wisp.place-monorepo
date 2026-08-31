import { MAX_PUBLIC_UPLOAD_ABSOLUTE_REQUEST_SIZE } from '@wispplace/constants'

// This leaves room for the multipart parser, application heap, and one active
// file buffer on the smallest production nodes when no explicit route budget
// is configured. High-memory upload nodes should set the env to 768 MiB.
export const DEFAULT_PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES = 32 * 1024 * 1024

export function resolvePublicUploadMemoryBudget(value = process.env.PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES): number {
	if (value === undefined) return DEFAULT_PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES
	if (!/^[1-9]\d*$/.test(value)) throw new Error('Invalid PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES')
	const bytes = Number(value)
	if (!Number.isSafeInteger(bytes) || bytes > MAX_PUBLIC_UPLOAD_ABSOLUTE_REQUEST_SIZE) {
		throw new Error('Invalid PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES')
	}
	return bytes
}

export const PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES = resolvePublicUploadMemoryBudget()
