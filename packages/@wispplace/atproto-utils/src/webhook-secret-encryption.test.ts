import { describe, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import {
	decryptWebhookSecret,
	encryptWebhookSecret,
	MAX_WEBHOOK_SECRET_BYTES,
	parseWebhookSecretEncryptionKeyring,
	WEBHOOK_SECRET_ENVELOPE_VERSION,
	WebhookSecretEncryptionError,
} from './webhook-secret-encryption'

const encodedKey = (byte: number): string => Buffer.alloc(32, byte).toString('base64url')
const activeKey = encodedKey(17)
const previousKey = encodedKey(34)

const keyring = (active = activeKey, previous?: string) =>
	parseWebhookSecretEncryptionKeyring({
		WEBHOOK_SECRET_ENCRYPTION_KEY: active,
		...(previous === undefined ? {} : { WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS: previous }),
	})

describe('server-managed webhook secret envelopes', () => {
	test('encrypts with a random 96-bit nonce and decrypts only with its authenticated envelope', () => {
		const ring = keyring()
		const token = 'wsk_a-test-token-that-is-not-stored-as-plaintext'
		const first = encryptWebhookSecret(token, ring)
		const second = encryptWebhookSecret(token, ring)

		expect(first).toStartWith(`${WEBHOOK_SECRET_ENVELOPE_VERSION}.`)
		expect(second).toStartWith(`${WEBHOOK_SECRET_ENVELOPE_VERSION}.`)
		expect(first).not.toBe(second)
		expect(first).not.toContain(token)
		expect(decryptWebhookSecret(first, ring)).toBe(token)
	})

	test('uses previous keys only for decryption during key rotation', () => {
		const oldRing = keyring(previousKey)
		const oldEnvelope = encryptWebhookSecret('wsk_before-rotation', oldRing)
		const rotatedRing = keyring(activeKey, previousKey)
		const newEnvelope = encryptWebhookSecret('wsk_after-rotation', rotatedRing)

		expect(decryptWebhookSecret(oldEnvelope, rotatedRing)).toBe('wsk_before-rotation')
		expect(decryptWebhookSecret(newEnvelope, rotatedRing)).toBe('wsk_after-rotation')
		expect(() => decryptWebhookSecret(oldEnvelope, keyring(activeKey))).toThrow(WebhookSecretEncryptionError)
	})

	test('rejects tampered, malformed, unknown-key, and cross-version envelopes with the same generic error', () => {
		const ring = keyring()
		const envelope = encryptWebhookSecret('wsk_tamper-test', ring)
		const [, keyId, nonce, ciphertext, tag] = envelope.split('.')
		const tamperedCiphertext = `${ciphertext!.slice(0, -1)}${ciphertext!.endsWith('A') ? 'B' : 'A'}`
		const candidates = [
			`${WEBHOOK_SECRET_ENVELOPE_VERSION}.${keyId}.${nonce}.${tamperedCiphertext}.${tag}`,
			`wse2.${keyId}.${nonce}.${ciphertext}.${tag}`,
			`${WEBHOOK_SECRET_ENVELOPE_VERSION}.aaaaaaaaaaaaaaaa.${nonce}.${ciphertext}.${tag}`,
			'wse1.not-an-envelope',
		]

		for (const candidate of candidates) {
			try {
				decryptWebhookSecret(candidate, ring)
				expect.unreachable('expected generic envelope failure')
			} catch (error) {
				expect(error).toBeInstanceOf(WebhookSecretEncryptionError)
				expect((error as Error).message).toBe('webhook_secret_encryption_unavailable')
			}
		}
	})

	test('accepts only canonical, unambiguous 32-byte key encodings', () => {
		const bytes = Buffer.alloc(32, 71)
		const hex = bytes.toString('hex')
		const base64url = bytes.toString('base64url')
		const base64 = bytes.toString('base64')

		for (const encoded of [hex, base64url, base64]) {
			const ring = keyring(encoded)
			expect(ring.activeKey.length).toBe(32)
		}

		for (const invalid of ['', ` ${hex}`, '00'.repeat(31), 'not-a-key', `${base64url}x`]) {
			expect(() => keyring(invalid)).toThrow(WebhookSecretEncryptionError)
		}
	})

	test('bounds plaintext and rejects duplicate or malformed prior keyrings', () => {
		const ring = keyring()
		expect(() => encryptWebhookSecret('x'.repeat(MAX_WEBHOOK_SECRET_BYTES + 1), ring)).toThrow(
			WebhookSecretEncryptionError,
		)
		expect(() => keyring(activeKey, activeKey)).toThrow(WebhookSecretEncryptionError)
		expect(() => keyring(activeKey, `${previousKey},`)).toThrow(WebhookSecretEncryptionError)
	})
})
