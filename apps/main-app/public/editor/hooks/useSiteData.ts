import { useCallback, useState } from 'react'

export interface Site {
	did: string
	rkey: string
	display_name: string | null
	created_at: number
	updated_at: number
}

export interface DomainInfo {
	type: 'wisp' | 'custom'
	domain: string
	verified?: boolean
	id?: string
}

export interface SiteWithDomains extends Site {
	domains?: DomainInfo[]
	isPrivate?: boolean
	siteId?: string
	expiresAt?: string | null
	expired?: boolean
	shareCount?: number
	privateUrl?: string
	fileCount?: number
	totalBytes?: number
}

export interface PrivateShare {
	shareId: string
	tokenPrefix: string
	label: string | null
	audienceDid: string | null
	expiresAt: string | null
	revokedAt: string | null
	createdAt: string
	lastUsedAt: string | null
	status: 'active' | 'expired' | 'revoked'
}

export function useSiteData() {
	const [sites, setSites] = useState<SiteWithDomains[]>([])
	const [sitesLoading, setSitesLoading] = useState(true)
	const [isSyncing, setIsSyncing] = useState(false)

	const fetchSites = useCallback(async () => {
		try {
			const [response, privateResponse] = await Promise.all([
				fetch('/api/user/sites'),
				fetch('/api/user/private-sites').catch(() => null),
			])
			const data = await response.json()
			const sitesData: Site[] = data.sites || []

			// Fetch domain info for each site
			const sitesWithDomains = await Promise.all(
				sitesData.map(async (site) => {
					try {
						const domainsResponse = await fetch(`/api/user/site/${site.rkey}/domains`)
						const domainsData = await domainsResponse.json()
						return {
							...site,
							domains: domainsData.domains || [],
						}
					} catch (err) {
						console.error(`Failed to fetch domains for site ${site.rkey}:`, err)
						return {
							...site,
							domains: [],
						}
					}
				}),
			)

			let privateSites: SiteWithDomains[] = []
			if (privateResponse?.ok) {
				try {
					const privateData = await privateResponse.json()
					privateSites = (privateData.sites || []).map(
						(p: {
							siteId: string
							name: string
							fileCount: number
							totalBytes: number
							expiresAt: string | null
							createdAt: string
							expired: boolean
							shareCount: number
							url: string
						}): SiteWithDomains => ({
							did: '',
							rkey: p.siteId,
							display_name: p.name,
							created_at: Math.floor(new Date(p.createdAt).getTime() / 1000),
							updated_at: Math.floor(new Date(p.createdAt).getTime() / 1000),
							domains: [],
							isPrivate: true,
							siteId: p.siteId,
							expiresAt: p.expiresAt,
							expired: p.expired,
							shareCount: p.shareCount,
							privateUrl: p.url,
							fileCount: p.fileCount,
							totalBytes: p.totalBytes,
						}),
					)
				} catch (err) {
					console.error('Failed to parse private sites:', err)
				}
			}

			setSites([...sitesWithDomains, ...privateSites].sort((a, b) => b.created_at - a.created_at))
		} catch (err) {
			console.error('Failed to fetch sites:', err)
		} finally {
			setSitesLoading(false)
		}
	}, [])

	const syncSites = useCallback(async () => {
		setIsSyncing(true)
		try {
			const response = await fetch('/api/user/sync', {
				method: 'POST',
			})
			const data = await response.json()
			if (data.success) {
				console.log(`Synced ${data.synced} sites from PDS`)
				// Refresh sites list
				await fetchSites()
			}
		} catch (err) {
			console.error('Failed to sync sites:', err)
			alert('Failed to sync sites from PDS')
		} finally {
			setIsSyncing(false)
		}
	}, [fetchSites])

	const deleteSite = useCallback(
		async (rkey: string, isPrivate = false) => {
			try {
				const response = await fetch(isPrivate ? `/api/user/private-sites/${rkey}` : `/api/site/${rkey}`, {
					method: 'DELETE',
				})

				const data = await response.json()
				if (data.success) {
					// Refresh sites list
					await fetchSites()
					return true
				} else {
					throw new Error(data.error || 'Failed to delete site')
				}
			} catch (err) {
				console.error('Delete site error:', err)
				alert(`Failed to delete site: ${err instanceof Error ? err.message : 'Unknown error'}`)
				return false
			}
		},
		[fetchSites],
	)

	return {
		sites,
		sitesLoading,
		isSyncing,
		fetchSites,
		syncSites,
		deleteSite,
	}
}
