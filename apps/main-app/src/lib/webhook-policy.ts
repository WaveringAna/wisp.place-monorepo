import {
	validateWebhookRecord,
	type WebhookEventKind,
	type WebhookRecordValidationErrorKind,
} from '@wispplace/atproto-utils'
import type { Main as WebhookRecord } from '@wispplace/lexicons/types/place/wisp/v2/wh'

export const MAX_WEBHOOKS_PER_OWNER = 50
export const MAX_WEBHOOK_LIST_LIMIT = 50
export const MAX_WEBHOOK_MUTATIONS_PER_MINUTE = 10
export const WEBHOOK_MUTATION_WINDOW_MS = 60_000

export const isWebhookOwnerAtCapacity = (recordCount: number): boolean =>
	Number.isSafeInteger(recordCount) && recordCount >= MAX_WEBHOOKS_PER_OWNER

export interface WebhookCreateInput {
	readonly scopeAturi: string
	readonly url: string
	readonly backlinks?: boolean
	readonly events?: readonly WebhookEventKind[]
	readonly secret?: string
	readonly secretId?: string
	readonly enabled?: boolean
}

export type WebhookCreateValidationResult =
	| { readonly ok: true; readonly record: WebhookRecord }
	| { readonly ok: false; readonly kind: 'secret_conflict' | WebhookRecordValidationErrorKind }

/**
 * Build one canonical PDS record only after applying the shared intake policy.
 * This route deliberately rejects both secret forms instead of relying on the
 * lexicon's precedence rule, because a caller should make that choice explicit.
 */
export const validateWebhookCreateInput = (
	input: WebhookCreateInput,
	options: { readonly allowLoopbackDev: boolean },
): WebhookCreateValidationResult => {
	if (input.secret !== undefined && input.secretId !== undefined) return { ok: false, kind: 'secret_conflict' }

	const validated = validateWebhookRecord(
		{
			$type: 'place.wisp.v2.wh',
			scope: {
				aturi: input.scopeAturi,
				...(input.backlinks === undefined ? {} : { backlinks: input.backlinks }),
			},
			url: input.url,
			...(input.events === undefined ? {} : { events: input.events }),
			...(input.secret === undefined ? {} : { secret: input.secret }),
			...(input.secretId === undefined ? {} : { secretId: input.secretId }),
			...(input.enabled === undefined ? {} : { enabled: input.enabled }),
			createdAt: new Date().toISOString(),
		},
		{ allowLoopbackDev: options.allowLoopbackDev },
	)
	if (!validated.ok) return validated
	return { ok: true, record: validated.record }
}

/** Clamp a parsed API list limit to the intentional owner-facing page bound. */
export const normalizeWebhookListLimit = (limit: number | undefined): number => {
	if (!Number.isSafeInteger(limit) || limit === undefined || limit < 1) return MAX_WEBHOOK_LIST_LIMIT
	return Math.min(limit, MAX_WEBHOOK_LIST_LIMIT)
}
