import type { Main as WhRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'
import { isValidWebhookSecretId } from './webhook-secret-id'

export type WebhookEventKind = 'create' | 'update' | 'delete'

export interface ParsedWebhookScope {
	readonly aturi: string
	readonly did: string
	readonly collection?: string
	readonly rkey?: string
}

export type WebhookRecordValidationErrorKind =
	| 'not_object'
	| 'type'
	| 'scope'
	| 'url'
	| 'events'
	| 'secret'
	| 'secret_id'
	| 'enabled'
	| 'created_at'

export type WebhookRecordValidationResult =
	| { readonly ok: true; readonly record: WhRecord; readonly scope: ParsedWebhookScope }
	| { readonly ok: false; readonly kind: WebhookRecordValidationErrorKind }

export interface WebhookRecordValidationOptions {
	/** Only permits http:// loopback endpoints for an explicitly enabled local development flow. */
	readonly allowLoopbackDev?: boolean
}

const MAX_ATURI_LENGTH = 2_048
const MAX_URL_LENGTH = 2_048
const MAX_SECRET_LENGTH = 256
const DID_PLC_RE = /^did:plc:[a-z2-7]{24}$/
const DID_WEB_RE =
	/^did:web:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?)*$/
const COLLECTION_RE = /^[A-Za-z0-9.*-]{1,253}$/
const RKEY_RE = /^[A-Za-z0-9._~:%@+-]{1,512}$/
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	try {
		const prototype = Object.getPrototypeOf(value)
		return prototype === Object.prototype || prototype === null
	} catch {
		return false
	}
}

function ownDataValue(value: Record<string, unknown>, key: string): { present: boolean; value: unknown } {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (descriptor?.enumerable !== true) return { present: false, value: undefined }
		if (!('value' in descriptor)) return { present: false, value: undefined }
		return { present: true, value: descriptor.value }
	} catch {
		return { present: false, value: undefined }
	}
}

export function isCanonicalWebhookDid(value: string): boolean {
	return value.length <= 2_048 && (DID_PLC_RE.test(value) || DID_WEB_RE.test(value))
}

/**
 * Parse only canonical repo authorities. Handles are intentionally rejected so a
 * scope cannot silently move when a handle changes ownership.
 */
export function parseWebhookScopeAtUri(aturi: string): ParsedWebhookScope | null {
	if (aturi.length === 0 || aturi.length > MAX_ATURI_LENGTH || !aturi.startsWith('at://') || /[?#\\\s]/.test(aturi)) {
		return null
	}
	const parts = aturi.slice('at://'.length).split('/')
	const [did, collection, rkey] = parts
	if (
		parts.length > 3 ||
		typeof did !== 'string' ||
		!isCanonicalWebhookDid(did) ||
		(collection !== undefined && (collection.length === 0 || !COLLECTION_RE.test(collection))) ||
		(rkey !== undefined && (rkey.length === 0 || !RKEY_RE.test(rkey)))
	) {
		return null
	}
	return Object.freeze({ aturi, did, collection, rkey })
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
	return (
		normalized === 'localhost' ||
		normalized.endsWith('.localhost') ||
		normalized === '127.0.0.1' ||
		normalized === '::1'
	)
}

/** Syntax-only URL validation. DNS/IP resolution belongs to the pinned delivery path. */
export function validateWebhookUrlSyntax(
	url: unknown,
	options: WebhookRecordValidationOptions = {},
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly kind: 'url' } {
	if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return { ok: false, kind: 'url' }
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return { ok: false, kind: 'url' }
	}
	if (parsed.username || parsed.password || parsed.hash || !parsed.hostname) return { ok: false, kind: 'url' }
	if (parsed.protocol === 'https:') return { ok: true, url }
	if (options.allowLoopbackDev && parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) {
		return { ok: true, url }
	}
	return { ok: false, kind: 'url' }
}

function validTimestamp(value: string): boolean {
	return value.length <= 128 && RFC3339_RE.test(value) && Number.isFinite(Date.parse(value))
}

/**
 * Validate and copy a webhook record. Unknown fields and accessors are stripped.
 * Records must choose either an inline secret or a server-managed secretId.
 */
export function validateWebhookRecord(
	value: unknown,
	options: WebhookRecordValidationOptions = {},
): WebhookRecordValidationResult {
	if (!isPlainObject(value)) return { ok: false, kind: 'not_object' }
	const type = ownDataValue(value, '$type')
	if (type.value !== 'place.wisp.v2.wh') return { ok: false, kind: 'type' }

	const rawScope = ownDataValue(value, 'scope')
	if (!rawScope.present || !isPlainObject(rawScope.value)) return { ok: false, kind: 'scope' }
	const rawAturi = ownDataValue(rawScope.value, 'aturi')
	const rawScopeType = ownDataValue(rawScope.value, '$type')
	const rawBacklinks = ownDataValue(rawScope.value, 'backlinks')
	if (
		!rawAturi.present ||
		typeof rawAturi.value !== 'string' ||
		(rawScopeType.present && rawScopeType.value !== 'place.wisp.v2.wh#atUri') ||
		(rawBacklinks.present && typeof rawBacklinks.value !== 'boolean')
	) {
		return { ok: false, kind: 'scope' }
	}
	const scope = parseWebhookScopeAtUri(rawAturi.value)
	if (!scope) return { ok: false, kind: 'scope' }

	const rawUrl = ownDataValue(value, 'url')
	const url = validateWebhookUrlSyntax(rawUrl.value, options)
	if (!url.ok) return url

	const rawCreatedAt = ownDataValue(value, 'createdAt')
	if (!rawCreatedAt.present || typeof rawCreatedAt.value !== 'string' || !validTimestamp(rawCreatedAt.value)) {
		return { ok: false, kind: 'created_at' }
	}

	const rawEvents = ownDataValue(value, 'events')
	let events: WebhookEventKind[] | undefined
	if (rawEvents.present) {
		if (!Array.isArray(rawEvents.value) || rawEvents.value.length > 3) return { ok: false, kind: 'events' }
		events = []
		const unique = new Set<WebhookEventKind>()
		for (const event of rawEvents.value) {
			if ((event !== 'create' && event !== 'update' && event !== 'delete') || unique.has(event)) {
				return { ok: false, kind: 'events' }
			}
			unique.add(event)
			events.push(event)
		}
	}

	const rawSecret = ownDataValue(value, 'secret')
	if (
		rawSecret.present &&
		(typeof rawSecret.value !== 'string' || rawSecret.value.length === 0 || rawSecret.value.length > MAX_SECRET_LENGTH)
	) {
		return { ok: false, kind: 'secret' }
	}
	const rawSecretId = ownDataValue(value, 'secretId')
	if (rawSecretId.present && !isValidWebhookSecretId(rawSecretId.value)) {
		return { ok: false, kind: 'secret_id' }
	}
	// A record must choose one signing mode. Rejecting ambiguous records avoids
	// silently changing the signing key when a PDS client serializes both fields.
	if (rawSecret.present && rawSecretId.present) return { ok: false, kind: 'secret' }
	const rawEnabled = ownDataValue(value, 'enabled')
	if (rawEnabled.present && typeof rawEnabled.value !== 'boolean') return { ok: false, kind: 'enabled' }

	const record: WhRecord = {
		$type: 'place.wisp.v2.wh',
		scope: {
			aturi: scope.aturi,
			...(rawScopeType.present ? { $type: 'place.wisp.v2.wh#atUri' as const } : {}),
			...(rawBacklinks.present ? { backlinks: rawBacklinks.value as boolean } : {}),
		},
		url: url.url,
		...(events === undefined ? {} : { events }),
		...(rawSecretId.present
			? { secretId: rawSecretId.value as string }
			: rawSecret.present
				? { secret: rawSecret.value as string }
				: {}),
		...(rawEnabled.present ? { enabled: rawEnabled.value as boolean } : {}),
		createdAt: rawCreatedAt.value,
	}
	return { ok: true, record, scope }
}
