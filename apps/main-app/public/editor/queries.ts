import { QueryClient, type QueryKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorText } from './api'
import { newestFirst, type Site, toPrivateSite, toPublicSite, toWebhook } from './model'
import { rememberAccount } from './remembered-accounts'
import { changedSiteName, overlayChanges, type SiteChange, waitUntilSettled } from './site-sync'
import { notify } from './store'

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 30_000,
			retry: (failures, error) => failures < 2 && !(error instanceof ApiError && error.status < 500),
		},
	},
})

export const keys = {
	user: ['user'],
	sites: ['sites'],
	pdsSync: ['pds-sync'],
	domains: ['domains'],
	webhooks: ['webhooks'],
	deliveries: ['webhook-deliveries'],
	secrets: ['secrets'],
	previews: ['previews'],
	shares: (siteId: string) => ['shares', siteId],
	settings: (rkey: string) => ['settings', rkey],
	wispAvailability: (handle: string) => ['wisp-availability', handle],
	marque: (domainId: string) => ['marque', domainId],
} as const

export const useUser = () =>
	useQuery({
		queryKey: keys.user,
		queryFn: () => api.user().then(rememberAccount),
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	})

/** Deploys and deletes made here that the server's site list does not show yet. */
let waitingChanges: readonly SiteChange[] = []

async function fetchSites(): Promise<Site[]> {
	const changes = waitingChanges
	// Private sites are an extra; a failure there must not hide the public list. While a
	// change is on its way the list is read from the primary, so replica lag cannot hold it up.
	const [publicSites, privateSites] = await Promise.all([
		api.sites(changes.length > 0),
		api.privateSites().catch(() => ({ sites: [] })),
	])
	const server = [...(publicSites.sites ?? []).map(toPublicSite), ...(privateSites.sites ?? []).map(toPrivateSite)]
	const { sites, waiting } = overlayChanges(server, changes)
	// Changes made while this request was out are kept for the next one.
	waitingChanges = waitingChanges.filter((change) => !changes.includes(change) || waiting.includes(change))
	return sites.sort(newestFirst)
}

/**
 * Shows a deploy or delete in the site list at once, then refetches on a short
 * backoff until the server list shows it too. If it has not after a minute the
 * list goes back to what the server says.
 */
export async function expectSiteChange(change: SiteChange): Promise<void> {
	waitingChanges = [...waitingChanges, change]
	// A refetch already in flight would land the list from before the change on top of it.
	await queryClient.cancelQueries({ queryKey: keys.sites })
	queryClient.setQueryData<Site[]>(
		keys.sites,
		(sites) => sites && overlayChanges(sites, [change]).sites.sort(newestFirst),
	)
	const settled = await waitUntilSettled(async () => {
		await queryClient.refetchQueries({ queryKey: keys.sites, type: 'all' })
		return !waitingChanges.includes(change)
	})
	if (settled) return
	waitingChanges = waitingChanges.filter((waiting) => waiting !== change)
	await queryClient.refetchQueries({ queryKey: keys.sites, type: 'all' })
	notify.ok(`the site list has not caught up with ${changedSiteName(change)} yet, refresh in a minute`)
}

/**
 * One PDS sync per page load. Sites the PDS has but the cache did not are
 * listed by the time it answers, so the site list refetches once.
 */
export const usePdsSync = () =>
	useQuery({
		queryKey: keys.pdsSync,
		queryFn: async () => {
			const result = await api.syncSites()
			if (result.queued > 0) await queryClient.invalidateQueries({ queryKey: keys.sites })
			return result
		},
		retry: false,
		staleTime: Number.POSITIVE_INFINITY,
	})

export const sitesQuery = { queryKey: keys.sites, queryFn: fetchSites }

export const useSites = () => useQuery(sitesQuery)

/**
 * When the dashboard last changed a domain. The list is normally read from a
 * nearby replica, which can lag that change, so for a while afterwards it is
 * read from the primary instead.
 */
let domainsChangedAt = Number.NEGATIVE_INFINITY
const FRESH_DOMAINS_MS = 60_000

export const useDomains = () =>
	useQuery({
		queryKey: keys.domains,
		queryFn: async () => {
			const fresh = Date.now() - domainsChangedAt < FRESH_DOMAINS_MS
			const { wispDomains = [], customDomains = [] } = await api.domains(fresh)
			return { wisp: wispDomains, custom: customDomains }
		},
	})

export const useWebhooks = () =>
	useQuery({ queryKey: keys.webhooks, queryFn: async () => ((await api.webhooks()).records ?? []).map(toWebhook) })

export const useDeliveries = () =>
	useQuery({
		queryKey: keys.deliveries,
		queryFn: async () => (await api.webhookDeliveries()).events ?? [],
		// Polling stops while the endpoint fails; refresh or refocusing the window tries again.
		refetchInterval: (query) => (query.state.status === 'error' ? false : 60_000),
	})

export const useSecrets = () =>
	useQuery({ queryKey: keys.secrets, queryFn: async () => (await api.secrets()).secrets ?? [] })

export const usePreviews = () => useQuery({ queryKey: keys.previews, queryFn: api.previews })

export const useShares = (siteId: string) =>
	useQuery({ queryKey: keys.shares(siteId), queryFn: async () => (await api.shares(siteId)).shares ?? [] })

export const useSiteSettings = (rkey: string) =>
	useQuery({ queryKey: keys.settings(rkey), queryFn: () => api.siteSettings(rkey), staleTime: 0 })

interface ActionOptions<V, R> {
	/** Query keys to refetch once the action succeeds. */
	invalidates?: readonly QueryKey[]
	success?: string | ((result: R, variables: V) => string)
	/** Prefix for the status line when the action fails. */
	failure: string
}

/** A mutation that refreshes what it touched and reports to the status line either way. */
export function useAction<V, R>(run: (variables: V) => Promise<R>, options: ActionOptions<V, R>) {
	const client = useQueryClient()
	return useMutation({
		mutationFn: run,
		onSuccess: async (result, variables) => {
			if (options.invalidates?.includes(keys.domains)) domainsChangedAt = Date.now()
			await Promise.all((options.invalidates ?? []).map((queryKey) => client.invalidateQueries({ queryKey })))
			const { success } = options
			if (success) notify.ok(typeof success === 'function' ? success(result, variables) : success)
		},
		onError: (error) => notify.error(`${options.failure}: ${errorText(error)}`),
	})
}
