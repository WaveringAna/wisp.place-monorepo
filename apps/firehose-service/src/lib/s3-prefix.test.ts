import { describe, expect, test } from 'bun:test'
import { resolveS3Prefix } from './s3-prefix'

describe('resolveS3Prefix', () => {
	test('defaults when unset or empty, as hosting does', () => {
		expect(resolveS3Prefix(undefined)).toBe('sites/')
		expect(resolveS3Prefix('')).toBe('sites/')
	})

	test('ends the prefix in exactly one slash', () => {
		expect(resolveS3Prefix('previews')).toBe('previews/')
		expect(resolveS3Prefix('previews/')).toBe('previews/')
	})

	test.each(['/abs/', '../up/', 'a/./b/', 'a\\b/', 'a b/', 'a\tb/'])('rejects %p', (value) => {
		expect(() => resolveS3Prefix(value)).toThrow('Invalid S3_PREFIX')
	})

	test('rejects a prefix over 512 characters', () => {
		expect(() => resolveS3Prefix(`${'x'.repeat(512)}/`)).toThrow('Invalid S3_PREFIX')
	})
})
