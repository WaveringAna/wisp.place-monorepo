import { useCallback, useState } from 'react'
import type { PrivateShare } from './useSiteData'

/**
 * Share-link management for a private site.
 *
 * The plaintext share URL only exists in the response to a create call — the server stores
 * a hash — so `justCreated` holds it in memory for the one-time reveal and is cleared as
 * soon as the panel closes.
 */
export function usePrivateShares() {
	const [shares, setShares] = useState<Record<string, PrivateShare[]>>({})
	const [loading, setLoading] = useState<Record<string, boolean>>({})
	const [justCreated, setJustCreated] = useState<{ siteId: string; url: string } | null>(null)

	const fetchShares = useCallback(async (siteId: string) => {
		setLoading((prev) => ({ ...prev, [siteId]: true }))
		try {
			const response = await fetch(`/api/user/private-sites/${siteId}/shares`)
			const data = await response.json()
			setShares((prev) => ({ ...prev, [siteId]: data.shares || [] }))
		} catch (err) {
			console.error('Failed to fetch share links:', err)
		} finally {
			setLoading((prev) => ({ ...prev, [siteId]: false }))
		}
	}, [])

	const createShare = useCallback(
		async (siteId: string, options: { label?: string; expiryMinutes?: number } = {}) => {
			try {
				const response = await fetch(`/api/user/private-sites/${siteId}/shares`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(options),
				})
				const data = await response.json()
				if (!data.success) throw new Error(data.error || 'Failed to create share link')

				// The only moment this URL is available. Surfaced once, never refetched.
				setJustCreated({ siteId, url: data.url })
				await fetchShares(siteId)
				return data.url as string
			} catch (err) {
				console.error('Create share error:', err)
				alert(`Failed to create share link: ${err instanceof Error ? err.message : 'Unknown error'}`)
				return null
			}
		},
		[fetchShares],
	)

	const revokeShare = useCallback(
		async (siteId: string, shareId: string) => {
			try {
				const response = await fetch(`/api/user/private-sites/${siteId}/shares/${shareId}`, { method: 'DELETE' })
				const data = await response.json()
				if (!data.success) throw new Error(data.error || 'Failed to revoke share link')
				await fetchShares(siteId)
				return true
			} catch (err) {
				console.error('Revoke share error:', err)
				alert(`Failed to revoke share link: ${err instanceof Error ? err.message : 'Unknown error'}`)
				return false
			}
		},
		[fetchShares],
	)

	const clearJustCreated = useCallback(() => setJustCreated(null), [])

	return { shares, loading, justCreated, fetchShares, createShare, revokeShare, clearJustCreated }
}
