import { useState } from 'react'

export interface CustomDomain {
	id: string
	domain: string
	did: string
	rkey: string
	verified: boolean
	last_verified_at: number | null
	created_at: number
}

export interface WispDomain {
	domain: string
	rkey: string | null
}

type VerificationStatus = 'idle' | 'verifying' | 'success' | 'error'

export function useDomainData() {
	const [wispDomain, setWispDomain] = useState<WispDomain | null>(null)
	const [customDomains, setCustomDomains] = useState<CustomDomain[]>([])
	const [domainsLoading, setDomainsLoading] = useState(true)
	const [verificationStatus, setVerificationStatus] = useState<{
		[id: string]: VerificationStatus
	}>({})

	const fetchDomains = async () => {
		try {
			const response = await fetch('/api/user/domains')
			const data = await response.json()
			setWispDomain(data.wispDomain)
			setCustomDomains(data.customDomains || [])
		} catch (err) {
			console.error('Failed to fetch domains:', err)
		} finally {
			setDomainsLoading(false)
		}
	}

	const addCustomDomain = async (domain: string) => {
		try {
			const response = await fetch('/api/domain/custom/add', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domain })
			})

			const data = await response.json()
			if (data.success) {
				await fetchDomains()
				return { success: true, id: data.id }
			} else {
				throw new Error(data.error || 'Failed to add domain')
			}
		} catch (err) {
			console.error('Add domain error:', err)
			alert(
				`Failed to add domain: ${err instanceof Error ? err.message : 'Unknown error'}`
			)
			return { success: false }
		}
	}

	const verifyDomain = async (id: string) => {
		setVerificationStatus({ ...verificationStatus, [id]: 'verifying' })

		try {
			const response = await fetch('/api/domain/custom/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			})

			const data = await response.json()
			if (data.success && data.verified) {
				setVerificationStatus({ ...verificationStatus, [id]: 'success' })
				await fetchDomains()
			} else {
				setVerificationStatus({ ...verificationStatus, [id]: 'error' })
				if (data.error) {
					alert(`Verification failed: ${data.error}`)
				}
			}
		} catch (err) {
			console.error('Verify domain error:', err)
			setVerificationStatus({ ...verificationStatus, [id]: 'error' })
			alert(
				`Verification failed: ${err instanceof Error ? err.message : 'Unknown error'}`
			)
		}
	}

	const deleteCustomDomain = async (id: string) => {
		if (!confirm('Are you sure you want to remove this custom domain?')) {
			return false
		}

		try {
			const response = await fetch(`/api/domain/custom/${id}`, {
				method: 'DELETE'
			})

			const data = await response.json()
			if (data.success) {
				await fetchDomains()
				return true
			} else {
				throw new Error('Failed to delete domain')
			}
		} catch (err) {
			console.error('Delete domain error:', err)
			alert(
				`Failed to delete domain: ${err instanceof Error ? err.message : 'Unknown error'}`
			)
			return false
		}
	}

	const mapWispDomain = async (siteRkey: string | null) => {
		try {
			const response = await fetch('/api/domain/wisp/map-site', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ siteRkey })
			})
			const data = await response.json()
			if (!data.success) throw new Error('Failed to map wisp domain')
			return true
		} catch (err) {
			console.error('Map wisp domain error:', err)
			throw err
		}
	}

	const mapCustomDomain = async (domainId: string, siteRkey: string | null) => {
		try {
			const response = await fetch(`/api/domain/custom/${domainId}/map-site`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ siteRkey })
			})
			const data = await response.json()
			if (!data.success) throw new Error(`Failed to map custom domain ${domainId}`)
			return true
		} catch (err) {
			console.error('Map custom domain error:', err)
			throw err
		}
	}

	const claimWispDomain = async (handle: string) => {
		try {
			const response = await fetch('/api/domain/claim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ handle })
			})

			const data = await response.json()
			if (data.success) {
				await fetchDomains()
				return { success: true }
			} else {
				throw new Error(data.error || 'Failed to claim domain')
			}
		} catch (err) {
			console.error('Claim domain error:', err)
			const errorMessage = err instanceof Error ? err.message : 'Unknown error'

			// Handle "Already claimed" error more gracefully
			if (errorMessage.includes('Already claimed')) {
				alert('You have already claimed a wisp.place subdomain. Please refresh the page.')
				await fetchDomains()
			} else {
				alert(`Failed to claim domain: ${errorMessage}`)
			}
			return { success: false, error: errorMessage }
		}
	}

	const checkWispAvailability = async (handle: string) => {
		const trimmedHandle = handle.trim().toLowerCase()
		if (!trimmedHandle) {
			return { available: null }
		}

		try {
			const response = await fetch(`/api/domain/check?handle=${encodeURIComponent(trimmedHandle)}`)
			const data = await response.json()
			return { available: data.available }
		} catch (err) {
			console.error('Check availability error:', err)
			return { available: false }
		}
	}

	return {
		wispDomain,
		customDomains,
		domainsLoading,
		verificationStatus,
		fetchDomains,
		addCustomDomain,
		verifyDomain,
		deleteCustomDomain,
		mapWispDomain,
		mapCustomDomain,
		claimWispDomain,
		checkWispAvailability
	}
}
