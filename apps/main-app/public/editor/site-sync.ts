import type { PublicSite, Site } from './model'
import type { UploadResult } from './upload-progress'

/**
 * A deploy or delete the dashboard just made. The site list is built by the
 * firehose service once the PDS event reaches it, so for a few seconds the
 * server still answers with the list from before.
 */
export type SiteChange =
	| { kind: 'deleted'; key: string; name: string }
	| { kind: 'deployed'; rkey: string; cid: string; at: number }

export const changedSiteName = (change: SiteChange) => (change.kind === 'deleted' ? change.name : change.rkey)

/** Whether a list from the server already shows the change. */
const landed = (sites: readonly Site[], change: SiteChange): boolean =>
	change.kind === 'deleted'
		? !sites.some((site) => site.key === change.key)
		: sites.some((site) => site.kind === 'public' && site.rkey === change.rkey && site.recordCid === change.cid)

/** The deployed site as it will be listed, keeping what the list already knew about it. */
const deployingSite = (change: Extract<SiteChange, { kind: 'deployed' }>, listed?: PublicSite): PublicSite => ({
	kind: 'public',
	key: `public:${change.rkey}`,
	rkey: change.rkey,
	name: change.rkey,
	createdAt: change.at,
	domains: [],
	...listed,
	updatedAt: change.at,
	recordCid: undefined,
	deploying: true,
})

const withChange = (sites: readonly Site[], change: SiteChange): Site[] => {
	if (landed(sites, change)) return [...sites]
	if (change.kind === 'deleted') return sites.filter((site) => site.key !== change.key)
	const key = `public:${change.rkey}`
	const listed = sites.find((site): site is PublicSite => site.key === key && site.kind === 'public')
	return [deployingSite(change, listed), ...sites.filter((site) => site.key !== key)]
}

/** The list as the dashboard knows it to be, and the changes the server list does not show yet. */
export const overlayChanges = (server: readonly Site[], changes: readonly SiteChange[]) => ({
	sites: changes.reduce(withChange, [...server]),
	waiting: changes.filter((change) => !landed(server, change)),
})

/** The site a finished public upload wrote, or null when it did not write one (private uploads). */
export function deployedChange(result: UploadResult, at: number): SiteChange | null {
	const rkey = result.uri?.match(/^at:\/\/[^/]+\/place\.wisp\.fs\/([^/]+)$/)?.[1]
	return rkey && result.cid ? { kind: 'deployed', rkey, cid: result.cid, at } : null
}

/**
 * Pauses between refetches while a change is on its way: 60 s in all, then the list is left to the
 * server. The firehose has been seen taking 43 s to list a deploy, so the tail keeps checking every 8 s.
 */
export const SETTLE_DELAYS_MS: readonly number[] = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 8000, 8000, 8000]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Checks again after each delay until `settled` holds; false once the delays run out. */
export async function waitUntilSettled(
	settled: () => Promise<boolean>,
	delays: readonly number[] = SETTLE_DELAYS_MS,
): Promise<boolean> {
	for (const delay of delays) {
		await sleep(delay)
		if (await settled()) return true
	}
	return false
}
