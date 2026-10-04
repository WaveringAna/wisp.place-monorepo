import { QueryClient, type QueryKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, errorText } from './api'
import { newestFirst, type Site, toPrivateSite, toPublicSite, toWebhook } from './model'
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
	shares: (siteId: string) => ['shares', siteId],
	settings: (rkey: string) => ['settings', rkey],
	wispAvailability: (handle: string) => ['wisp-availability', handle],
} as const

export const useUser = () =>
	useQuery({ queryKey: keys.user, queryFn: api.user, retry: false, staleTime: Number.POSITIVE_INFINITY })

async function fetchSites(): Promise<Site[]> {
	// Private sites are an extra; a failure there must not hide the public list.
	const [publicSites, privateSites] = await Promise.all([api.sites(), api.privateSites().catch(() => ({ sites: [] }))])
	return [...(publicSites.sites ?? []).map(toPublicSite), ...(privateSites.sites ?? []).map(toPrivateSite)].sort(
		newestFirst,
	)
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

export const useSites = () => useQuery({ queryKey: keys.sites, queryFn: fetchSites })

export const useDomains = () =>
	useQuery({
		queryKey: keys.domains,
		queryFn: async () => {
			const { wispDomains = [], customDomains = [] } = await api.domains()
			return { wisp: wispDomains, custom: customDomains }
		},
	})

export const useWebhooks = () =>
	useQuery({ queryKey: keys.webhooks, queryFn: async () => ((await api.webhooks()).records ?? []).map(toWebhook) })

export const useDeliveries = () =>
	useQuery({
		queryKey: keys.deliveries,
		queryFn: async () => (await api.webhookDeliveries()).events ?? [],
		refetchInterval: 60_000,
	})

export const useSecrets = () =>
	useQuery({ queryKey: keys.secrets, queryFn: async () => (await api.secrets()).secrets ?? [] })

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
			await Promise.all((options.invalidates ?? []).map((queryKey) => client.invalidateQueries({ queryKey })))
			const { success } = options
			if (success) notify.ok(typeof success === 'function' ? success(result, variables) : success)
		},
		onError: (error) => notify.error(`${options.failure}: ${errorText(error)}`),
	})
}
