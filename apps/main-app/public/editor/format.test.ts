import { describe, expect, test } from 'bun:test'
import { expiresIn, formatBytes, plural, timeAgo } from './format'

const NOW = Date.parse('2026-10-03T12:00:00Z')

describe('format', () => {
	test('sizes', () => {
		expect(formatBytes(512)).toBe('512 B')
		expect(formatBytes(1536)).toBe('1.5 KB')
		expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
	})

	test('relative times', () => {
		expect(timeAgo(NOW - 5_000, NOW)).toBe('just now')
		expect(timeAgo(NOW - 12 * 60_000, NOW)).toBe('12m ago')
		expect(timeAgo(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h ago')
		expect(timeAgo(NOW - 4 * 86_400_000, NOW)).toBe('4d ago')
		expect(expiresIn(null, NOW)).toBe('never expires')
		expect(expiresIn(new Date(NOW - 1).toISOString(), NOW)).toBe('expired')
		expect(expiresIn(new Date(NOW + 90_000).toISOString(), NOW)).toBe('expires in 2m')
		expect(expiresIn(new Date(NOW + 5 * 86_400_000).toISOString(), NOW)).toBe('expires in 5d')
	})

	test('plurals', () => {
		expect(plural(1, 'file')).toBe('1 file')
		expect(plural(0, 'file')).toBe('0 files')
	})
})
