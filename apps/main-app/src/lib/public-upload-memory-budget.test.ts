import { expect, test } from 'bun:test'
import { MAX_PUBLIC_UPLOAD_ABSOLUTE_REQUEST_SIZE } from '@wispplace/constants'
import {
	DEFAULT_PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES,
	resolvePublicUploadMemoryBudget,
} from './public-upload-memory-budget'

test('public upload memory budget defaults safely and parses only bounded decimal bytes', () => {
	expect(resolvePublicUploadMemoryBudget(undefined)).toBe(DEFAULT_PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES)
	expect(resolvePublicUploadMemoryBudget('805306368')).toBe(MAX_PUBLIC_UPLOAD_ABSOLUTE_REQUEST_SIZE)
	for (const value of ['', ' 32', '32 ', '+32', '-1', '1.5', '0', 'Infinity', '805306369']) {
		expect(() => resolvePublicUploadMemoryBudget(value)).toThrow('Invalid PUBLIC_UPLOAD_MEMORY_BUDGET_BYTES')
	}
})
