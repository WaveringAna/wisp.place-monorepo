import { describe, expect, test } from 'bun:test'
import { isValidWebhookSecretId, MAX_WEBHOOK_SECRET_ID_LENGTH } from './webhook-secret-id'

describe('webhook secret ID validation', () => {
	test('accepts the exact 64-character conservative boundary', () => {
		const value = `a${'b'.repeat(MAX_WEBHOOK_SECRET_ID_LENGTH - 1)}`
		expect(value).toHaveLength(MAX_WEBHOOK_SECRET_ID_LENGTH)
		expect(isValidWebhookSecretId(value)).toBe(true)
		expect(isValidWebhookSecretId('secret.name_01-v2')).toBe(true)
	})

	test('rejects oversized, unicode, slash, and encoded-path IDs', () => {
		for (const value of [
			'a'.repeat(MAX_WEBHOOK_SECRET_ID_LENGTH + 1),
			'secret-☃',
			'secret/name',
			'secret%2Fname',
			'secret%2fname',
			'',
		]) {
			expect(isValidWebhookSecretId(value)).toBe(false)
		}
	})
})
