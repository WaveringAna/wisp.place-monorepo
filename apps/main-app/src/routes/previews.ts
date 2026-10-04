import { Agent } from '@atproto/api'
import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { BASE_HOST } from '@wispplace/constants'
import { createLogger } from '@wispplace/observability'
import { safeFetch } from '@wispplace/safe-fetch'
import { Elysia, t } from 'elysia'
import { consumeWebhookMutationRateLimit, eventualRead, withWebhookOwnerMutationLock } from '../lib/db'
import { canSetSpindleSecrets } from '../lib/oauth-authorize'
import {
	disablePreview,
	enablePreview,
	loadPreviews,
	type PreviewSetupPorts,
	type PreviewSetupRefusal,
} from '../lib/preview-setup'
import {
	isClaimLabel,
	isRepoName,
	PREVIEW_SECRET_KEY,
	parsePreviewHook,
	previewHookRecord,
	previewHookRkey,
	type TangledRepo,
	toTangledRepos,
} from '../lib/previews'
import { isWebhookOwnerAtCapacity, MAX_WEBHOOKS_PER_OWNER, validateWebhookCreateInput } from '../lib/webhook-policy'
import { type AuthenticatedContext, requireAuth, SESSION_COOKIE_NAME } from '../lib/wisp-auth'

const logger = createLogger('main-app')

/** Unset means previews are off, as on the hosting service; the dashboard says so instead of offering setup. */
const PREVIEW_HOST = process.env.PREVIEW_HOST?.trim().toLowerCase() || null
const PREVIEW_BOT_URL = (process.env.PREVIEW_BOT_URL || 'https://preview-bot.wisp.place').replace(/\/$/, '')
const MAX_REPOS = 300
const SPINDLE_TIMEOUT_MS = 8_000

const STATUS: Record<PreviewSetupRefusal, number> = {
	'unknown-repo': 404,
	'no-spindle': 409,
	'claim-not-owned': 403,
	'needs-ci-permission': 403,
	'bad-app-password': 422,
	'secret-failed': 502,
}

class PreviewLimitError extends Error {}

const repoUri = (did: string, repo: TangledRepo) => `at://${did}/sh.tangled.repo/${repo.rkey}`

/** The JWT payload's `scope`, without verifying it: only used to tell an app password from the account password. */
const tokenScope = (jwt: unknown): string | undefined => {
	if (typeof jwt !== 'string') return undefined
	try {
		const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'))
		return typeof payload?.scope === 'string' ? payload.scope : undefined
	} catch {
		return undefined
	}
}

async function listAll(agent: Agent, did: string, collection: string, max: number): Promise<unknown[]> {
	const records: unknown[] = []
	let cursor: string | undefined
	while (records.length < max) {
		const page = await agent.com.atproto.repo.listRecords({
			repo: did,
			collection,
			limit: Math.min(100, max - records.length),
			...(cursor ? { cursor } : {}),
		})
		records.push(...page.data.records)
		cursor = page.data.cursor
		if (!cursor || page.data.records.length === 0) break
	}
	return records
}

function httpPorts({ did, session }: AuthenticatedContext): PreviewSetupPorts {
	const agent = new Agent((url, init) => session.fetchHandler(url, init))

	const spindleCall = async (repo: TangledRepo, lxm: string, init: RequestInit & { query?: string } = {}) => {
		const { data } = await agent.com.atproto.server.getServiceAuth({
			aud: `did:web:${repo.spindle}`,
			lxm,
			exp: Math.floor(Date.now() / 1000) + 60,
		})
		const response = await safeFetch(`https://${repo.spindle}/xrpc/${lxm}${init.query ?? ''}`, {
			...init,
			headers: { ...init.headers, Authorization: `Bearer ${data.token}` },
			timeout: SPINDLE_TIMEOUT_MS,
			maxRedirects: 0,
		})
		if (!response.ok) throw new Error(`spindle answered ${response.status}`)
		return response
	}

	const listHooks = async () =>
		(await listAll(agent, did, 'place.wisp.v2.wh', MAX_WEBHOOKS_PER_OWNER)).flatMap((item) => {
			const { uri, value } = item as { uri?: unknown; value?: unknown }
			const rkey = typeof uri === 'string' ? (uri.split('/').pop() ?? '') : ''
			const hook = parsePreviewHook(PREVIEW_BOT_URL, rkey, value)
			return hook ? [hook] : []
		})

	return {
		listRepos: async () => toTangledRepos(await listAll(agent, did, 'sh.tangled.repo', MAX_REPOS)),
		listHooks,
		claims: async () => {
			const { wispDomains } = await eventualRead.getDomainsForDid(did)
			const suffix = `.${BASE_HOST}`
			return wispDomains.flatMap(({ domain }) => (domain.endsWith(suffix) ? [domain.slice(0, -suffix.length)] : []))
		},
		canSetSecrets: () => canSetSpindleSecrets(session),
		hasSecret: async (repo) => {
			const query = `?${new URLSearchParams({ repo: repoUri(did, repo) })}`
			const body = (await (await spindleCall(repo, 'sh.tangled.repo.listSecrets', { query })).json()) as {
				secrets?: { key?: unknown }[]
			}
			return (body.secrets ?? []).some((secret) => secret.key === PREVIEW_SECRET_KEY)
		},
		checkAppPassword: async (password) => {
			const pds = (await session.getTokenInfo(false)).aud
			const response = await safeFetch(`${pds.replace(/\/$/, '')}/xrpc/com.atproto.server.createSession`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifier: did, password }),
				timeout: SPINDLE_TIMEOUT_MS,
				maxRedirects: 0,
			})
			if (response.status === 401) return false
			if (!response.ok) throw new Error(`pds answered ${response.status}`)
			const created = (await response.json()) as { accessJwt?: unknown; refreshJwt?: unknown }
			// The check made a session; end it so the only one left is the workflow's.
			if (typeof created.refreshJwt === 'string') {
				await safeFetch(`${pds.replace(/\/$/, '')}/xrpc/com.atproto.server.deleteSession`, {
					method: 'POST',
					headers: { Authorization: `Bearer ${created.refreshJwt}` },
					timeout: SPINDLE_TIMEOUT_MS,
					maxRedirects: 0,
				}).catch(() => undefined)
			}
			// Only the access token's scope tells an app password apart from the account password.
			return tokenScope(created.accessJwt)?.startsWith('com.atproto.appPass') === true
		},
		setSecret: async (repo, value) => {
			await spindleCall(repo, 'sh.tangled.repo.addSecret', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ repo: repoUri(did, repo), key: PREVIEW_SECRET_KEY, value }),
			})
		},
		putHook: (repo, claim) =>
			withWebhookOwnerMutationLock(did, async () => {
				if (!(await consumeWebhookMutationRateLimit(did, 'create'))) throw new PreviewLimitError()
				const rkey = previewHookRkey(repo.name)
				const existing = await listAll(agent, did, 'place.wisp.v2.wh', MAX_WEBHOOKS_PER_OWNER + 1)
				const replacing = existing.some(
					(item) => (item as { uri?: unknown }).uri === `at://${did}/place.wisp.v2.wh/${rkey}`,
				)
				if (!replacing && isWebhookOwnerAtCapacity(existing.length)) throw new PreviewLimitError()
				const validated = validateWebhookCreateInput(previewHookRecord(PREVIEW_BOT_URL, did, repo.name, claim), {
					allowLoopbackDev: false,
				})
				if (!validated.ok) throw new Error(`preview hook rejected: ${validated.kind}`)
				await agent.com.atproto.repo.putRecord({
					repo: did,
					collection: 'place.wisp.v2.wh',
					rkey,
					record: validated.record,
				})
			}),
		deleteHook: (rkey) =>
			withWebhookOwnerMutationLock(did, async () => {
				if (!(await consumeWebhookMutationRateLimit(did, 'delete'))) throw new PreviewLimitError()
				await agent.com.atproto.repo.deleteRecord({ repo: did, collection: 'place.wisp.v2.wh', rkey })
			}),
	}
}

const failed = (set: { status?: number | string }, error: unknown, action: string) => {
	if (error instanceof PreviewLimitError) {
		set.status = 429
		return { success: false, error: 'Webhook limit or rate limit reached' }
	}
	logger.error(`[Previews] ${action} failed`, {
		errorKind: error instanceof Error ? error.constructor.name : 'unknown',
	})
	set.status = 500
	return { success: false, error: `Failed to ${action}` }
}

/** Pull-request previews for the signed-in user's tangled repos. */
export const previewRoutes = (
	client: NodeOAuthClient,
	cookieSecret: string,
	portsFor: (auth: AuthenticatedContext) => PreviewSetupPorts = httpPorts,
) =>
	new Elysia({ prefix: '/api/previews', cookie: { secrets: cookieSecret, sign: [SESSION_COOKIE_NAME] } })
		.derive(async ({ cookie, request }) => ({
			ports: portsFor(await requireAuth(client, cookie, request.headers.get('cookie'))),
		}))
		/** GET /api/previews: { repos, claims, canSetSecrets } */
		.get('/', async ({ ports, set }) => {
			try {
				return { success: true, previewHost: PREVIEW_HOST, ...(await loadPreviews(ports)) }
			} catch (error) {
				return failed(set, error, 'list previews')
			}
		})
		/** PUT /api/previews/:repo { claim, appPassword? }: store the deploy secret, then wake the bot on deploys. */
		.put(
			'/:repo',
			async ({ ports, params, body, set }) => {
				if (!isRepoName(params.repo) || !isClaimLabel(body.claim)) {
					set.status = 400
					return { success: false, error: 'invalid-request' }
				}
				try {
					const result = await enablePreview(ports, { repo: params.repo, ...body })
					if (result.ok) return { success: true }
					set.status = STATUS[result.reason]
					return { success: false, error: result.reason }
				} catch (error) {
					return failed(set, error, 'enable previews')
				}
			},
			{
				params: t.Object({ repo: t.String({ minLength: 1, maxLength: 100 }) }),
				body: t.Object({
					claim: t.String({ minLength: 1, maxLength: 63 }),
					appPassword: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
				}),
			},
		)
		/** DELETE /api/previews/:repo */
		.delete(
			'/:repo',
			async ({ ports, params, set }) => {
				try {
					await disablePreview(ports, params.repo)
					return { success: true }
				} catch (error) {
					return failed(set, error, 'disable previews')
				}
			},
			{ params: t.Object({ repo: t.String({ minLength: 1, maxLength: 100 }) }) },
		)
