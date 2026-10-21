import { describe, expect, test } from 'bun:test'
import { isValidHandle } from './domain-utils'

describe('isValidHandle', () => {
	test('accepts an ordinary subdomain', () => {
		expect(isValidHandle('my-site')).toBe(true)
	})

	test('refuses names the wisp.place zone routes to infrastructure', () => {
		for (const name of [
			'moderation',
			'status',
			'status-origin',
			'sites',
			'us-east',
			'singapore',
			'mesh',
			'dns',
			'priv',
			'preview-bot',
		]) {
			expect(isValidHandle(name)).toBe(false)
			expect(isValidHandle(name.toUpperCase())).toBe(false)
		}
	})
})
