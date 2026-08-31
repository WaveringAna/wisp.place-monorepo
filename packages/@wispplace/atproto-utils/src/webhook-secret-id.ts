/**
 * Canonical identifier for a server-managed webhook signing secret.
 *
 * This is deliberately stricter than the broad AT Protocol record-key format:
 * a secret ID is used in both a URL path and a webhook record, so only a small
 * ASCII subset is accepted. Keep this check at every trust boundary.
 */
export const MAX_WEBHOOK_SECRET_ID_LENGTH = 64
export const WEBHOOK_SECRET_ID_PATTERN = '^[A-Za-z0-9._-]{1,64}$'

const webhookSecretIdRegex = new RegExp(WEBHOOK_SECRET_ID_PATTERN)

export const isValidWebhookSecretId = (value: unknown): value is string =>
	typeof value === 'string' && value.length <= MAX_WEBHOOK_SECRET_ID_LENGTH && webhookSecretIdRegex.test(value)
