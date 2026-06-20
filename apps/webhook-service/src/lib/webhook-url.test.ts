import { describe, expect, test } from 'bun:test'
import { assertSafeWebhookUrl, assertSafeWebhookUrlSyntax } from './webhook-url'

describe('webhook URL validation', () => {
	test('requires HTTPS URLs without credentials', () => {
		expect(() => assertSafeWebhookUrlSyntax('http://example.com/webhook')).toThrow('HTTPS')
		expect(() => assertSafeWebhookUrlSyntax('https://user:pass@example.com/webhook')).toThrow('credentials')
		expect(() => assertSafeWebhookUrlSyntax('https://example.com/webhook')).not.toThrow()
	})

	test('blocks direct private and metadata IP destinations', async () => {
		await expect(assertSafeWebhookUrl('https://127.0.0.1/webhook')).rejects.toThrow('private address')
		await expect(assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow('private address')
		await expect(assertSafeWebhookUrl('https://[::1]/webhook')).rejects.toThrow('private address')
	})
})
