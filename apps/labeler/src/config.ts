export const DEFAULT_LABEL_VALUES = ['!takedown', '!hide', 'spam', 'mass-created'] as const

export type LabelerConfig = {
	did: string
	signingKeyHex: string
	databaseUrl: string
	adminToken: string
	host: string
	port: number
	values: string[]
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
	}
}
