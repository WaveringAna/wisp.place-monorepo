import { describe, expect, test } from 'bun:test'
import {
	isValidWebhookSecretToken,
	MAX_WEBHOOK_SECRET_TOKEN_LENGTH,
	MIN_WEBHOOK_SECRET_TOKEN_LENGTH,
} from './webhook-secret-token'

describe('caller-supplied webhook secret token validation', () => {
	test('accepts generated wsk_ tokens, base64url secrets, and both length boundaries', () => {
		for (const value of [
			`wsk_${'A'.repeat(32)}`,
			'Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5',
			'k'.repeat(MIN_WEBHOOK_SECRET_TOKEN_LENGTH),
			'k'.repeat(MAX_WEBHOOK_SECRET_TOKEN_LENGTH),
			`${'a'.repeat(30)}!~`,
		]) {
			expect(isValidWebhookSecretToken(value)).toBe(true)
		}
	})

	test('rejects short, oversized, whitespace, non-ASCII, and non-string tokens', () => {
		for (const value of [
			'',
			'k'.repeat(MIN_WEBHOOK_SECRET_TOKEN_LENGTH - 1),
			'k'.repeat(MAX_WEBHOOK_SECRET_TOKEN_LENGTH + 1),
			`${'k'.repeat(40)} `,
			`${'k'.repeat(40)}\n`,
			`${'k'.repeat(20)}\t${'k'.repeat(20)}`,
			`${'k'.repeat(40)}☃`,
			undefined,
			null,
			42,
		]) {
			expect(isValidWebhookSecretToken(value)).toBe(false)
		}
	})
})
