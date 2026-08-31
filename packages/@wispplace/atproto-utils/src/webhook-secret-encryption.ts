import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * The only supported on-disk format for server-managed webhook secrets.
 *
 * It is deliberately a small, strict wire format. The version and key ID are
 * authenticated as AES-GCM additional authenticated data, so neither can be
 * changed without detection.
 */
export const WEBHOOK_SECRET_ENVELOPE_VERSION = 'wse1'
export const WEBHOOK_SECRET_ENVELOPE_PREFIX = `${WEBHOOK_SECRET_ENVELOPE_VERSION}.`
export const WEBHOOK_SECRET_ENCRYPTION_ERROR = 'webhook_secret_encryption_unavailable'

const AES_256_KEY_BYTES = 32
const GCM_NONCE_BYTES = 12 // 96 bits, the AES-GCM recommended nonce size.
const GCM_AUTH_TAG_BYTES = 16
const KEY_ID_BYTES = 12
const KEY_ID_LENGTH = (KEY_ID_BYTES * 4) / 3 // base64url encoding of KEY_ID_BYTES.
const MAX_PREVIOUS_KEYS = 8
const MAX_KEYRING_INPUT_BYTES = 4096
const MAX_ENVELOPE_BYTES = 1024

/** A webhook token is normally 36 bytes. Keep enough room for future tokens, but never decrypt unbounded data. */
export const MAX_WEBHOOK_SECRET_BYTES = 512

const BASE64URL_KEY_RE = /^[A-Za-z0-9_-]{43}$/
const BASE64_KEY_RE = /^[A-Za-z0-9+/]{43}=$/
const HEX_KEY_RE = /^[A-Fa-f0-9]{64}$/
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/
const KEY_ID_RE = new RegExp(`^[A-Za-z0-9_-]{${KEY_ID_LENGTH}}$`)

export interface WebhookSecretEncryptionEnvironment {
	readonly WEBHOOK_SECRET_ENCRYPTION_KEY?: string
	readonly WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS?: string
}

/**
 * This error intentionally has no detail. In particular, it never says if a
 * key, envelope segment, auth tag, or plaintext was invalid.
 */
export class WebhookSecretEncryptionError extends Error {
	constructor() {
		super(WEBHOOK_SECRET_ENCRYPTION_ERROR)
		this.name = 'WebhookSecretEncryptionError'
	}
}

export interface WebhookSecretEncryptionKeyring {
	/** Fingerprint of the active key. It is safe to persist in an envelope. */
	readonly activeKeyId: string
	/** Internal key material. Do not log or serialize this object. */
	readonly activeKey: Buffer
	/** Includes the active key and any configured previous keys. */
	readonly keysById: ReadonlyMap<string, Buffer>
}

function encryptionFailure(): never {
	throw new WebhookSecretEncryptionError()
}

const constantTimeBytesEqual = (left: Buffer, right: Buffer): boolean => {
	if (left.length !== right.length) return false
	let different = 0
	for (let index = 0; index < left.length; index++) {
		different |= left[index]! ^ right[index]!
	}
	return different === 0
}

/**
 * Parse one 32-byte key without guessing at a lossy encoding.
 *
 * Accepted raw values are exactly one of:
 * - 64 hexadecimal characters;
 * - 43 unpadded base64url characters; or
 * - 44 canonical padded base64 characters.
 *
 * Whitespace, URL-safe padding, unpadded standard base64, and mixed formats
 * are rejected rather than normalized. This makes deployment mistakes fail
 * closed rather than select a surprising key.
 */
const parseEncryptionKey = (encoded: string | undefined): Buffer => {
	if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > 128) return encryptionFailure()

	let decoded: Buffer
	if (HEX_KEY_RE.test(encoded)) {
		decoded = Buffer.from(encoded, 'hex')
		if (decoded.toString('hex') !== encoded.toLowerCase()) return encryptionFailure()
	} else if (BASE64URL_KEY_RE.test(encoded)) {
		decoded = Buffer.from(encoded, 'base64url')
		if (decoded.toString('base64url') !== encoded) return encryptionFailure()
	} else if (BASE64_KEY_RE.test(encoded)) {
		decoded = Buffer.from(encoded, 'base64')
		if (decoded.toString('base64') !== encoded) return encryptionFailure()
	} else {
		return encryptionFailure()
	}

	if (decoded.length !== AES_256_KEY_BYTES) return encryptionFailure()
	return decoded
}

const keyIdFor = (key: Buffer): string => createHash('sha256').update(key).digest('base64url').slice(0, KEY_ID_LENGTH)

/**
 * Parse the active key and an optional comma-separated previous keyring.
 * Previous keys are decrypt-only; every new envelope always uses the active
 * key. An absent or empty previous-key value means there are no previous keys.
 */
export const parseWebhookSecretEncryptionKeyring = (
	environment: WebhookSecretEncryptionEnvironment,
): WebhookSecretEncryptionKeyring => {
	try {
		const activeKey = parseEncryptionKey(environment.WEBHOOK_SECRET_ENCRYPTION_KEY)
		const activeKeyId = keyIdFor(activeKey)
		const keysById = new Map<string, Buffer>([[activeKeyId, activeKey]])
		const encodedPrevious = environment.WEBHOOK_SECRET_ENCRYPTION_PREVIOUS_KEYS

		if (encodedPrevious !== undefined && encodedPrevious !== '') {
			if (encodedPrevious.length > MAX_KEYRING_INPUT_BYTES) encryptionFailure()
			const values = encodedPrevious.split(',')
			if (values.length > MAX_PREVIOUS_KEYS || values.some((value) => value.length === 0)) encryptionFailure()

			for (const value of values) {
				const key = parseEncryptionKey(value)
				const keyId = keyIdFor(key)
				const existing = keysById.get(keyId)
				// Duplicate keys and the vanishingly unlikely truncated-ID collision are
				// configuration errors. Do not make decryption key selection ambiguous.
				if (existing || !KEY_ID_RE.test(keyId)) encryptionFailure()
				keysById.set(keyId, key)
			}
		}

		return Object.freeze({
			activeKeyId,
			activeKey,
			keysById,
		})
	} catch {
		return encryptionFailure()
	}
}

/** A named alias for callers that pass process.env directly. */
export const createWebhookSecretEncryptionKeyringFromEnv = parseWebhookSecretEncryptionKeyring

const envelopeAdditionalData = (version: string, keyId: string): Buffer => Buffer.from(`${version}.${keyId}`, 'utf8')

const decodeCanonicalBase64url = (encoded: string, maximumBytes: number): Buffer => {
	if (encoded.length === 0 || encoded.length > MAX_ENVELOPE_BYTES || !BASE64URL_RE.test(encoded))
		return encryptionFailure()

	let decoded: Buffer
	try {
		decoded = Buffer.from(encoded, 'base64url')
	} catch {
		return encryptionFailure()
	}
	if (decoded.length === 0 || decoded.length > maximumBytes || decoded.toString('base64url') !== encoded) {
		return encryptionFailure()
	}
	return decoded
}

interface ParsedEnvelope {
	readonly keyId: string
	readonly nonce: Buffer
	readonly ciphertext: Buffer
	readonly authTag: Buffer
}

const parseEnvelope = (envelope: string): ParsedEnvelope => {
	if (typeof envelope !== 'string' || envelope.length > MAX_ENVELOPE_BYTES) return encryptionFailure()
	const parts = envelope.split('.')
	if (parts.length !== 5) return encryptionFailure()

	const [version, keyId, encodedNonce, encodedCiphertext, encodedAuthTag] = parts as [
		string,
		string,
		string,
		string,
		string,
	]
	if (version !== WEBHOOK_SECRET_ENVELOPE_VERSION || !KEY_ID_RE.test(keyId)) return encryptionFailure()

	const nonce = decodeCanonicalBase64url(encodedNonce, GCM_NONCE_BYTES)
	const ciphertext = decodeCanonicalBase64url(encodedCiphertext, MAX_WEBHOOK_SECRET_BYTES)
	const authTag = decodeCanonicalBase64url(encodedAuthTag, GCM_AUTH_TAG_BYTES)
	if (nonce.length !== GCM_NONCE_BYTES || authTag.length !== GCM_AUTH_TAG_BYTES) return encryptionFailure()

	return { keyId, nonce, ciphertext, authTag }
}

const encodePlaintext = (secret: string): Buffer => {
	if (typeof secret !== 'string' || secret.length === 0 || secret.length > MAX_WEBHOOK_SECRET_BYTES * 2)
		return encryptionFailure()
	const plaintext = Buffer.from(secret, 'utf8')
	if (plaintext.length === 0 || plaintext.length > MAX_WEBHOOK_SECRET_BYTES) return encryptionFailure()
	return plaintext
}

/** Encrypt a webhook token using the active AES-256-GCM key. */
export const encryptWebhookSecret = (secret: string, keyring: WebhookSecretEncryptionKeyring): string => {
	try {
		const plaintext = encodePlaintext(secret)
		const nonce = randomBytes(GCM_NONCE_BYTES)
		const cipher = createCipheriv('aes-256-gcm', keyring.activeKey, nonce, { authTagLength: GCM_AUTH_TAG_BYTES })
		cipher.setAAD(envelopeAdditionalData(WEBHOOK_SECRET_ENVELOPE_VERSION, keyring.activeKeyId), {
			plaintextLength: plaintext.length,
		})
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
		const authTag = cipher.getAuthTag()

		if (
			ciphertext.length === 0 ||
			ciphertext.length > MAX_WEBHOOK_SECRET_BYTES ||
			authTag.length !== GCM_AUTH_TAG_BYTES
		) {
			encryptionFailure()
		}

		return [
			WEBHOOK_SECRET_ENVELOPE_VERSION,
			keyring.activeKeyId,
			nonce.toString('base64url'),
			ciphertext.toString('base64url'),
			authTag.toString('base64url'),
		].join('.')
	} catch {
		return encryptionFailure()
	}
}

/**
 * Decrypt a version-1 envelope. Unknown keys, malformed fields, changed
 * version/key IDs, and invalid tags deliberately all produce the same error.
 */
export const decryptWebhookSecret = (envelope: string, keyring: WebhookSecretEncryptionKeyring): string => {
	try {
		const { keyId, nonce, ciphertext, authTag } = parseEnvelope(envelope)
		const key = keyring.keysById.get(keyId)
		if (!key || key.length !== AES_256_KEY_BYTES) return encryptionFailure()

		const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: GCM_AUTH_TAG_BYTES })
		decipher.setAAD(envelopeAdditionalData(WEBHOOK_SECRET_ENVELOPE_VERSION, keyId), {
			plaintextLength: ciphertext.length,
		})
		decipher.setAuthTag(authTag)
		const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
		if (plaintext.length === 0 || plaintext.length > MAX_WEBHOOK_SECRET_BYTES) return encryptionFailure()

		const decoded = plaintext.toString('utf8')
		// Do not return a replacement-character decoding for malformed bytes.
		if (!constantTimeBytesEqual(Buffer.from(decoded, 'utf8'), plaintext)) return encryptionFailure()
		return decoded
	} catch {
		return encryptionFailure()
	}
}

/** Whether a value claims to use the encrypted envelope namespace. */
export const isWebhookSecretEnvelopeCandidate = (value: unknown): value is string =>
	typeof value === 'string' && value.startsWith(WEBHOOK_SECRET_ENVELOPE_PREFIX)
