/**
 * Caller-supplied webhook signing token.
 *
 * The server normally generates a `wsk_` token, but a receiver that already
 * generates its own signing secret (for example an agent harness) can register
 * that value instead. The token only ever feeds HMAC-SHA256, so any printable
 * ASCII works; the bounds keep it strong enough and well inside the
 * encrypted-envelope size limit. Whitespace is rejected so a copy/paste
 * newline cannot silently produce a different secret than the receiver's.
 */
export const MIN_WEBHOOK_SECRET_TOKEN_LENGTH = 32
export const MAX_WEBHOOK_SECRET_TOKEN_LENGTH = 256

const webhookSecretTokenRegex = new RegExp(
	`^[\\x21-\\x7E]{${MIN_WEBHOOK_SECRET_TOKEN_LENGTH},${MAX_WEBHOOK_SECRET_TOKEN_LENGTH}}$`,
)

export const isValidWebhookSecretToken = (value: unknown): value is string =>
	typeof value === 'string' && value.length <= MAX_WEBHOOK_SECRET_TOKEN_LENGTH && webhookSecretTokenRegex.test(value)
