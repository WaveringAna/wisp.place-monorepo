import { MODERATION_SCHEMA_STATEMENTS } from '@wispplace/database'
import { createLogger } from '@wispplace/observability'
import type postgres from 'postgres'
import type { ModerationConfig } from '../config'
import interfacePage from '../ui/index.html'
import loginPage from '../ui/login.html'
import { createModerationApi } from './api'
import { createModeratorAuth } from './auth'
import { createModerationStore } from './store'
import { createSiteSync, resolveHandleFromDidDoc } from './sync'
import { createModelClassifier, createTriageWorker } from './triage'

const logger = createLogger('moderation')

export async function migrateModeration(sql: postgres.Sql) {
	for (const statement of MODERATION_SCHEMA_STATEMENTS) await sql.unsafe(statement)
}

/**
 * The moderation queue: keeps moderation_sites in step with site_cache, runs the
 * model's first pass, and serves the interface and its API.
 */
export async function startModeration({
	sql,
	config,
	labelerDid,
	emitLabel,
}: {
	sql: postgres.Sql
	config: ModerationConfig
	labelerDid: string
	emitLabel: (label: { uri: string; val: string; neg: boolean; note: string }) => Promise<{ seq: number }>
}) {
	await migrateModeration(sql)
	const store = createModerationStore(sql, labelerDid)
	const sync = createSiteSync({ sql, store })
	const triage = config.triageUrl
		? createTriageWorker({
				store,
				model: config.triageModel,
				classify: createModelClassifier({ endpoint: config.triageUrl, model: config.triageModel }),
			})
		: null
	const auth = createModeratorAuth({
		sql,
		publicUrl: config.publicUrl,
		moderators: new Set(config.moderators),
		resolveHandle: resolveHandleFromDidDoc,
	})
	const api = createModerationApi({ store, auth, emitLabel, apiToken: config.apiToken })

	let ticking = false
	async function tick() {
		if (ticking) return
		ticking = true
		try {
			await sync.syncAll()
			if (triage) await triage.drain()
		} catch (error) {
			logger.warn('Moderation pass failed', { error: (error as Error).message })
		} finally {
			ticking = false
		}
	}
	const syncTimer = setInterval(tick, config.syncIntervalMs)
	const deletedTimer = setInterval(() => void store.markMissingDeleted().catch(() => {}), 10 * 60_000)
	void tick()

	const text = (body: string, status: number) => new Response(`${body}\n`, { status })
	return {
		store,
		stop() {
			clearInterval(syncTimer)
			clearInterval(deletedTimer)
		},
		routes: {
			'/': interfacePage,
			'/login': loginPage,
			'/logout': (req: Request) => auth.logout(req),
			'/oauth-client-metadata.json': () => auth.metadata(),
			'/oauth/login': async (req: Request) => {
				const handle = new URL(req.url).searchParams.get('handle')?.trim().replace(/^@/, '')
				if (!handle) return new Response(null, { status: 302, headers: { location: '/login' } })
				return auth.start(handle).catch((error) => text(`could not start sign-in: ${(error as Error).message}`, 400))
			},
			'/oauth/callback': (req: Request) =>
				auth.callback(req).catch((error) => text(`sign-in failed: ${(error as Error).message}`, 400)),
			...api,
		},
	}
}
