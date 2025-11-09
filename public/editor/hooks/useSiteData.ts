import { useState } from 'react'

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
}

export function useSiteData() {
	const [sites, setSites] = useState<SiteWithDomains[]>([])
	const [sitesLoading, setSitesLoading] = useState(true)
	const [isSyncing, setIsSyncing] = useState(false)

	const fetchSites = async () => {
		try {
			const response = await fetch('/api/user/sites')
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
							domains: domainsData.domains || []
						}
					} catch (err) {
						console.error(`Failed to fetch domains for site ${site.rkey}:`, err)
						return {
							...site,
							domains: []
						}
					}
				})
			)

			setSites(sitesWithDomains)
		} catch (err) {
			console.error('Failed to fetch sites:', err)
		} finally {
			setSitesLoading(false)
		}
	}

	const syncSites = async () => {
		setIsSyncing(true)
		try {
			const response = await fetch('/api/user/sync', {
				method: 'POST'
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
	}

	const deleteSite = async (rkey: string) => {
		try {
			const response = await fetch(`/api/site/${rkey}`, {
				method: 'DELETE'
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
			alert(
				`Failed to delete site: ${err instanceof Error ? err.message : 'Unknown error'}`
			)
			return false
		}
	}

	return {
		sites,
		sitesLoading,
		isSyncing,
		fetchSites,
		syncSites,
		deleteSite
	}
}
