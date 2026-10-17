export const DEFAULT_LABEL_VALUES = ['!takedown', '!hide', 'spam', 'mass-created'] as const

export type ModerationConfig = {
	/** The https origin the interface is served at; OAuth needs it. */
	publicUrl: string
	moderators: string[]
	apiToken: string
	triageUrl: string | null
	triageModel: string
	syncIntervalMs: number
}

export type LabelerConfig = {
	did: string
	signingKeyHex: string
	databaseUrl: string
	adminToken: string
	host: string
	port: number
	values: string[]
	/** The moderation queue and interface; off unless MODERATION_PUBLIC_URL is set. */
	moderation: ModerationConfig | null
}

type Env = Readonly<Record<string, string | undefined>>

function required(env: Env, name: string): string {
	const value = env[name]?.trim()
	if (!value) throw new Error(`${name} is required`)
	return value
}

/** Labeler settings from an environment object; throws on anything missing or malformed. */
export function resolveLabelerConfig(env: Env): LabelerConfig {
	const did = required(env, 'LABELER_DID')
	if (!/^did:(plc|web):/.test(did)) throw new Error('LABELER_DID must be a did:plc or did:web')
	const signingKeyHex = required(env, 'LABELER_SIGNING_KEY')
	if (!/^[0-9a-f]{64}$/i.test(signingKeyHex)) throw new Error('LABELER_SIGNING_KEY must be 32 bytes of hex')
	const adminToken = required(env, 'LABELER_ADMIN_TOKEN')
	if (adminToken.length < 32) throw new Error('LABELER_ADMIN_TOKEN must be at least 32 characters')
	const port = Number(env.LABELER_PORT ?? 3010)
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('LABELER_PORT must be a port number')
	const values = (env.LABELER_VALUES ?? DEFAULT_LABEL_VALUES.join(','))
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean)
	return {
		did,
		signingKeyHex,
		databaseUrl: required(env, 'DATABASE_URL'),
		adminToken,
		host: env.LABELER_HOST?.trim() || '127.0.0.1',
		port,
		values,
		moderation: resolveModerationConfig(env),
	}
}

function resolveModerationConfig(env: Env): ModerationConfig | null {
	const publicUrl = env.MODERATION_PUBLIC_URL?.trim().replace(/\/$/, '')
	if (!publicUrl) return null
	if (!publicUrl.startsWith('https://')) throw new Error('MODERATION_PUBLIC_URL must be an https origin')
	const moderators = (env.MODERATOR_DIDS ?? '')
		.split(',')
		.map((d) => d.trim())
		.filter(Boolean)
	if (moderators.length === 0) throw new Error('MODERATOR_DIDS is required with MODERATION_PUBLIC_URL')
	const apiToken = env.MODERATION_API_TOKEN?.trim() ?? ''
	if (apiToken && apiToken.length < 32) throw new Error('MODERATION_API_TOKEN must be at least 32 characters')
	const syncIntervalMs = Number(env.MODERATION_SYNC_INTERVAL_MS ?? 30_000)
	if (!Number.isInteger(syncIntervalMs) || syncIntervalMs < 1000)
		throw new Error('MODERATION_SYNC_INTERVAL_MS must be ≥ 1000')
	return {
		publicUrl,
		moderators,
		apiToken,
		triageUrl: env.TRIAGE_URL?.trim().replace(/\/$/, '') || null,
		triageModel: env.TRIAGE_MODEL?.trim() || 'bonsai-2-27b',
		syncIntervalMs,
	}
}
