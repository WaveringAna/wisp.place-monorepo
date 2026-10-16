import { createLogger } from '@wispplace/observability'

const logger = createLogger('moderation')

/** moderation.wisp.place, the labeler whose `!takedown` labels hosting obeys. */
export const DEFAULT_LABELER_DID = 'did:plc:25fzqofm2xkx27bcaicxbyxk'
const REFRESH_INTERVAL_MS = 10_000

/** The labeler to obey: WISP_LABELER_DID, or moderation.wisp.place; `off` disables takedowns. */
export function resolveLabelerDid(env: Readonly<Record<string, string | undefined>>): string | null {
	const value = env.WISP_LABELER_DID?.trim()
	if (value === 'off') return null
	return value || DEFAULT_LABELER_DID
}

/** The label subject of one site: its place.wisp.fs record. */
export const siteSubject = (did: string, rkey: string) => `at://${did}/place.wisp.fs/${rkey}`

export type TakedownsDeps = {
	/** Subjects (account DIDs or site record URIs) with an active `!takedown` label. */
	load: () => Promise<readonly string[]>
	refreshIntervalMs?: number
}

/**
 * Active takedowns, held in memory and reloaded from the labeler's table on an
 * interval, so a request never waits on the database for it. A failed reload
 * keeps the last good set: a database blip must not restore taken-down sites.
 */
export function createTakedowns({ load, refreshIntervalMs = REFRESH_INTERVAL_MS }: TakedownsDeps) {
	let active: ReadonlySet<string> = new Set()
	let timer: ReturnType<typeof setInterval> | undefined
	let failing = false

	async function refresh(): Promise<void> {
		try {
			const subjects = await load()
			active = new Set(subjects)
			if (failing) logger.info('Takedown list reloaded', { count: active.size })
			failing = false
		} catch (error) {
			// Database errors can carry connection details, so log only the code.
			const code = (error as { code?: unknown }).code
			if (!failing) logger.warn('Takedown list reload failed; keeping the last one', { count: active.size, code })
			failing = true
		}
	}

	return {
		refresh,
		start(): Promise<void> {
			timer ??= setInterval(() => void refresh(), refreshIntervalMs)
			timer.unref?.()
			return refresh()
		},
		stop(): void {
			if (timer) clearInterval(timer)
			timer = undefined
		},
		isTakenDown(did: string, rkey: string): boolean {
			return active.has(did) || active.has(siteSubject(did, rkey))
		},
	}
}

const TAKEDOWN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Site unavailable</title>
<style>
body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, sans-serif; color: #2b2230; background: #f7f2ee; }
main { max-width: 32rem; padding: 2rem; }
h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
a { color: #b2456e; }
@media (prefers-color-scheme: dark) { body { color: #efe8f2; background: #1b1824; } a { color: #f08cb3; } }
</style>
</head>
<body>
<main>
<h1>This site is unavailable</h1>
<p>It was removed for violating the wisp.place <a href="https://wisp.place/acceptable-use">acceptable use policy</a>.</p>
</main>
</body>
</html>
`

/** 451 Unavailable For Legal Reasons, uncached so a restored site comes back at once. */
export function takedownResponse(method: string): Response {
	return new Response(method === 'HEAD' ? null : TAKEDOWN_PAGE, {
		status: 451,
		headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
	})
}
