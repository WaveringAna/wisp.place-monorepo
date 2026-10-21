import { describe, expect, test } from 'bun:test'
import { s3ReadLine } from './s3-read-log'

const request = (key: string | undefined, operation = 'GetObject') => ({
	operation,
	outcome: 'ok' as const,
	durationMs: 123.4,
	...(key !== undefined && { key }),
})

describe('S3 read log line', () => {
	test('names a read by a stable hash of its key, never the key itself', () => {
		const path = 'did:plc:abc/site/.rewritten/secret-diary/index.html'
		const line = s3ReadLine(request(path))
		expect(line).toEqual({
			keyHash: expect.stringMatching(/^[0-9a-f]{16}$/),
			keyKind: 'rewritten',
			outcome: 'ok',
			durationMs: 123,
		})
		expect(JSON.stringify(line)).not.toContain('secret-diary')
		expect(s3ReadLine(request(path))?.keyHash).toBe(line?.keyHash)
		expect(s3ReadLine(request(`${path}x`))?.keyHash).not.toBe(line?.keyHash)
	})

	test('tells shared CAS bodies apart from other keys', () => {
		expect(s3ReadLine(request('sites/cas/bafyabc.css'))?.keyKind).toBe('cas')
		expect(s3ReadLine(request('cas/bafyabc.css'))?.keyKind).toBe('cas')
		expect(s3ReadLine(request('did:plc:abc/site/index.html'))?.keyKind).toBe('other')
	})

	test('carries the failure name of a failed read', () => {
		const failed = { ...request('cas/a'), outcome: 'error' as const, error: 'TimeoutError' }
		expect(s3ReadLine(failed)).toMatchObject({ outcome: 'error', error: 'TimeoutError' })
		expect(s3ReadLine(request('cas/a'))).not.toHaveProperty('error')
	})

	test('only GetObject with a key gets a line', () => {
		expect(s3ReadLine(request('cas/a', 'HeadObject'))).toBeNull()
		expect(s3ReadLine(request(undefined))).toBeNull()
	})
})
