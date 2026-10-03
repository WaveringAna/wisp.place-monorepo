export interface Config {
	botHandle: string
	botPassword: string
	databaseUrl: string
	previewHost: string
	baseHost: string
	port: number
}

const HANDLE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

function requireHost(value: string | undefined, name: string): string {
	const trimmed = value?.trim().toLowerCase() ?? ''
	if (!HOST.test(trimmed)) throw new Error(`Invalid ${name}: expected a plain hostname`)
	return trimmed
}

function resolvePort(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === '') return fallback
	const n = Number(value.trim())
	if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new Error(`Invalid PORT: ${value}`)
	return n
}

export function resolveConfig(env: Record<string, string | undefined>): Config {
	const botHandle = env.BOT_HANDLE?.trim().toLowerCase() ?? ''
	if (!HANDLE.test(botHandle)) throw new Error('Invalid BOT_HANDLE')

	const botPassword = env.BOT_PASSWORD ?? ''
	if (botPassword.length === 0) throw new Error('BOT_PASSWORD is required')

	const databaseUrl = env.DATABASE_URL?.trim() ?? ''
	if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
		throw new Error('Invalid DATABASE_URL: expected postgres://')
	}

	const previewHost = requireHost(env.PREVIEW_HOST, 'PREVIEW_HOST')
	const baseHost = env.BASE_HOST ? requireHost(env.BASE_HOST, 'BASE_HOST') : 'wisp.place'
	const port = resolvePort(env.PORT, 3004)

	return { botHandle, botPassword, databaseUrl, previewHost, baseHost, port }
}
