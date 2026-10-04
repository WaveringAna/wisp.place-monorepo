import { type PreviewHook, type PreviewRow, previewRows, type TangledRepo } from './previews'

/**
 * Everything preview setup reads and writes, as plain functions over the
 * signed-in user. The route supplies the real ones; tests use fakes.
 */
export interface PreviewSetupPorts {
	listRepos(): Promise<TangledRepo[]>
	listHooks(): Promise<PreviewHook[]>
	/** Wisp subdomain labels the user has claimed. */
	claims(): Promise<string[]>
	/** Whether the session was granted the spindle secret methods. */
	canSetSecrets(): Promise<boolean>
	hasSecret(repo: TangledRepo): Promise<boolean>
	checkAppPassword(password: string): Promise<boolean>
	setSecret(repo: TangledRepo, value: string): Promise<void>
	putHook(repo: TangledRepo, claim: string): Promise<void>
	deleteHook(rkey: string): Promise<void>
}

export interface PreviewRepo extends PreviewRow {
	/** Whether the repo's spindle holds the deploy secret; unknown without permission to ask. */
	secret: 'set' | 'missing' | 'unknown'
}

export interface PreviewsView {
	repos: PreviewRepo[]
	claims: string[]
	canSetSecrets: boolean
}

const secretState = async (ports: PreviewSetupPorts, row: PreviewRow, allowed: boolean) => {
	if (!allowed || row.blocked) return 'unknown' as const
	try {
		return (await ports.hasSecret(row)) ? ('set' as const) : ('missing' as const)
	} catch {
		return 'unknown' as const
	}
}

export async function loadPreviews(ports: PreviewSetupPorts): Promise<PreviewsView> {
	const [repos, hooks, claims, canSetSecrets] = await Promise.all([
		ports.listRepos(),
		ports.listHooks(),
		ports.claims(),
		ports.canSetSecrets(),
	])
	const rows = previewRows(repos, hooks)
	const secrets = await Promise.all(rows.map((row) => secretState(ports, row, canSetSecrets)))
	return {
		repos: rows.map((row, index) => ({ ...row, secret: secrets[index] ?? 'unknown' })),
		claims,
		canSetSecrets,
	}
}

export type PreviewSetupRefusal =
	| 'unknown-repo'
	| 'no-spindle'
	| 'claim-not-owned'
	| 'needs-ci-permission'
	| 'bad-app-password'
	| 'secret-failed'

export type PreviewSetupResult = { ok: true } | { ok: false; reason: PreviewSetupRefusal }

export interface EnablePreviewInput {
	repo: string
	claim: string
	/** App password for the workflow to deploy with; stored on the spindle, never by wisp. */
	appPassword?: string
}

const refuse = (reason: PreviewSetupRefusal): PreviewSetupResult => ({ ok: false, reason })

/** The secret goes first, so a hook never wakes the bot for a repo whose workflow cannot deploy. */
export async function enablePreview(ports: PreviewSetupPorts, input: EnablePreviewInput): Promise<PreviewSetupResult> {
	const [repos, claims] = await Promise.all([ports.listRepos(), ports.claims()])
	const repo = repos.find((candidate) => candidate.name === input.repo)
	if (!repo) return refuse('unknown-repo')
	if (!repo.spindle || !repo.repoDid) return refuse('no-spindle')
	if (!claims.includes(input.claim)) return refuse('claim-not-owned')

	if (input.appPassword !== undefined) {
		if (!(await ports.canSetSecrets())) return refuse('needs-ci-permission')
		if (!(await ports.checkAppPassword(input.appPassword))) return refuse('bad-app-password')
		try {
			await ports.setSecret(repo, input.appPassword)
		} catch {
			return refuse('secret-failed')
		}
	}

	await ports.putHook(repo, input.claim)
	return { ok: true }
}

export async function disablePreview(ports: PreviewSetupPorts, repo: string): Promise<PreviewSetupResult> {
	const hook = (await ports.listHooks()).find((candidate) => candidate.repo === repo)
	if (hook) await ports.deleteHook(hook.rkey)
	return { ok: true }
}
