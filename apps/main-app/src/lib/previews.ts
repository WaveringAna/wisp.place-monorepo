/**
 * Pull-request previews, as the dashboard sets them up: one place.wisp.v2.wh
 * record per enabled repo, watching the owner's site records and waking the
 * preview bot with the repo and claim in its URL. The bot trusts neither; it
 * re-reads every fact from its authority before it comments.
 */

/** The secret a preview workflow deploys with. */
export const PREVIEW_SECRET_KEY = 'WISP_APP_PASSWORD'

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/
const CLAIM = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

export const isRepoName = (value: string): boolean => REPO_NAME.test(value)
export const isClaimLabel = (value: string): boolean => CLAIM.test(value) && value.length <= 63

/** A `sh.tangled.repo` record, reduced to what preview setup needs. */
export interface TangledRepo {
	rkey: string
	name: string
	spindle: string | undefined
	repoDid: string | undefined
	knot: string | undefined
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
const host = (value: unknown): string | undefined => {
	const candidate = text(value)
	return candidate && HOST.test(candidate) ? candidate : undefined
}

/** Repos without a `name` are named by their record key, as tangled does. */
export function toTangledRepos(records: readonly unknown[]): TangledRepo[] {
	return records.flatMap((item) => {
		if (!isObject(item) || typeof item.uri !== 'string' || !isObject(item.value)) return []
		const rkey = item.uri.split('/').pop() ?? ''
		if (!rkey) return []
		const value = item.value
		return [
			{
				rkey,
				name: text(value.name) ?? rkey,
				spindle: host(value.spindle),
				repoDid: text(value.repoDid),
				knot: host(value.knot),
			},
		]
	})
}

export const previewHookRkey = (repo: string): string => `preview-${repo}`

const hookPath = (botUrl: string) => `${botUrl}/v1/hook`

/** The webhook-create input for one repo; site writes of other repos wake the bot too and are ignored there. */
export const previewHookRecord = (botUrl: string, did: string, repo: string, claim: string) => ({
	scopeAturi: `at://${did}/place.wisp.fs`,
	url: `${hookPath(botUrl)}?${new URLSearchParams({ repo, claim })}`,
	events: ['create', 'update'] as ('create' | 'update')[],
	enabled: true,
})

export interface PreviewHook {
	rkey: string
	repo: string
	claim: string
	/** DID of the repo's owner when the hook is for a repo the user collaborates on; null for their own. */
	owner: string | null
}

/** A webhook record that wakes the preview bot, or null for anything else. */
export function parsePreviewHook(botUrl: string, rkey: string, value: unknown): PreviewHook | null {
	const url = isObject(value) ? text(value.url) : undefined
	if (!url?.startsWith(`${hookPath(botUrl)}?`)) return null
	const params = new URLSearchParams(url.slice(hookPath(botUrl).length + 1))
	const repo = params.get('repo') ?? ''
	const claim = params.get('claim') ?? ''
	const owner = params.get('owner') || null
	return isRepoName(repo) && isClaimLabel(claim) ? { rkey, repo, claim, owner } : null
}

/** The hook for one of the user's own repos; a collaborator hook for a same-named repo is someone else's. */
export const ownHookFor = (hooks: readonly PreviewHook[], repo: string): PreviewHook | undefined =>
	hooks.find((hook) => hook.repo === repo && hook.owner === null)

/** Why previews cannot be turned on for a repo: the bot needs its spindle and its own DID. */
export type PreviewBlock = 'no-spindle' | 'no-repo-did'

export interface PreviewRow extends TangledRepo {
	preview: { claim: string; hookRkey: string } | null
	blocked: PreviewBlock | null
}

export const previewBlock = (repo: TangledRepo): PreviewBlock | null =>
	!repo.spindle ? 'no-spindle' : !repo.repoDid ? 'no-repo-did' : null

export function previewRows(repos: readonly TangledRepo[], hooks: readonly PreviewHook[]): PreviewRow[] {
	return repos.map((repo) => {
		const hook = ownHookFor(hooks, repo.name)
		return {
			...repo,
			preview: hook ? { claim: hook.claim, hookRkey: hook.rkey } : null,
			blocked: previewBlock(repo),
		}
	})
}
