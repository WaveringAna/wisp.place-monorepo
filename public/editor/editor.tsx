import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@public/components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle
} from '@public/components/ui/card'
import { Input } from '@public/components/ui/input'
import { Label } from '@public/components/ui/label'
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger
} from '@public/components/ui/tabs'
import { Badge } from '@public/components/ui/badge'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter
} from '@public/components/ui/dialog'
import {
	Globe,
	Upload,
	ExternalLink,
	CheckCircle2,
	XCircle,
	AlertCircle,
	Loader2,
	Trash2,
	RefreshCw,
	Settings
} from 'lucide-react'
import { RadioGroup, RadioGroupItem } from '@public/components/ui/radio-group'
import { CodeBlock } from '@public/components/ui/code-block'

import Layout from '@public/layouts'

interface UserInfo {
	did: string
	handle: string
}

interface Site {
	did: string
	rkey: string
	display_name: string | null
	created_at: number
	updated_at: number
}

interface CustomDomain {
	id: string
	domain: string
	did: string
	rkey: string
	verified: boolean
	last_verified_at: number | null
	created_at: number
}

interface WispDomain {
	domain: string
	rkey: string | null
}

function Dashboard() {
	// User state
	const [userInfo, setUserInfo] = useState<UserInfo | null>(null)
	const [loading, setLoading] = useState(true)

	// Sites state
	const [sites, setSites] = useState<Site[]>([])
	const [sitesLoading, setSitesLoading] = useState(true)
	const [isSyncing, setIsSyncing] = useState(false)

	// Domains state
	const [wispDomain, setWispDomain] = useState<WispDomain | null>(null)
	const [customDomains, setCustomDomains] = useState<CustomDomain[]>([])
	const [domainsLoading, setDomainsLoading] = useState(true)

	// Site configuration state
	const [configuringSite, setConfiguringSite] = useState<Site | null>(null)
	const [selectedDomain, setSelectedDomain] = useState<string>('')
	const [isSavingConfig, setIsSavingConfig] = useState(false)
	const [isDeletingSite, setIsDeletingSite] = useState(false)

	// Upload state
	const [siteMode, setSiteMode] = useState<'existing' | 'new'>('existing')
	const [selectedSiteRkey, setSelectedSiteRkey] = useState<string>('')
	const [newSiteName, setNewSiteName] = useState('')
	const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null)
	const [isUploading, setIsUploading] = useState(false)
	const [uploadProgress, setUploadProgress] = useState('')
	const [skippedFiles, setSkippedFiles] = useState<Array<{ name: string; reason: string }>>([])
	const [uploadedCount, setUploadedCount] = useState(0)

	// Custom domain modal state
	const [addDomainModalOpen, setAddDomainModalOpen] = useState(false)
	const [customDomain, setCustomDomain] = useState('')
	const [isAddingDomain, setIsAddingDomain] = useState(false)
	const [verificationStatus, setVerificationStatus] = useState<{
		[id: string]: 'idle' | 'verifying' | 'success' | 'error'
	}>({})
	const [viewDomainDNS, setViewDomainDNS] = useState<string | null>(null)

	// Wisp domain claim state
	const [wispHandle, setWispHandle] = useState('')
	const [isClaimingWisp, setIsClaimingWisp] = useState(false)
	const [wispAvailability, setWispAvailability] = useState<{
		available: boolean | null
		checking: boolean
	}>({ available: null, checking: false })

	// Fetch user info on mount
	useEffect(() => {
		fetchUserInfo()
		fetchSites()
		fetchDomains()
	}, [])

	// Auto-switch to 'new' mode if no sites exist
	useEffect(() => {
		if (!sitesLoading && sites.length === 0 && siteMode === 'existing') {
			setSiteMode('new')
		}
	}, [sites, sitesLoading, siteMode])

	const fetchUserInfo = async () => {
		try {
			const response = await fetch('/api/user/info')
			const data = await response.json()
			setUserInfo(data)
		} catch (err) {
			console.error('Failed to fetch user info:', err)
		} finally {
			setLoading(false)
		}
	}

	const fetchSites = async () => {
		try {
			const response = await fetch('/api/user/sites')
			const data = await response.json()
			setSites(data.sites || [])
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

	const getSiteUrl = (site: Site) => {
		// Check if this site is mapped to the wisp.place domain
		if (wispDomain && wispDomain.rkey === site.rkey) {
			return `https://${wispDomain.domain}`
		}

		// Check if this site is mapped to any custom domain
		const customDomain = customDomains.find((d) => d.rkey === site.rkey)
		if (customDomain) {
			return `https://${customDomain.domain}`
		}

		// Default fallback URL
		if (!userInfo) return '#'
		return `https://sites.wisp.place/${site.did}/${site.rkey}`
	}

	const getSiteDomainName = (site: Site) => {
		if (wispDomain && wispDomain.rkey === site.rkey) {
			return wispDomain.domain
		}

		const customDomain = customDomains.find((d) => d.rkey === site.rkey)
		if (customDomain) {
			return customDomain.domain
		}

		return `sites.wisp.place/${site.did}/${site.rkey}`
	}

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files && e.target.files.length > 0) {
			setSelectedFiles(e.target.files)
		}
	}

	const handleUpload = async () => {
		const siteName = siteMode === 'existing' ? selectedSiteRkey : newSiteName

		if (!siteName) {
			alert(siteMode === 'existing' ? 'Please select a site' : 'Please enter a site name')
			return
		}

		setIsUploading(true)
		setUploadProgress('Preparing files...')

		try {
			const formData = new FormData()
			formData.append('siteName', siteName)

			if (selectedFiles) {
				for (let i = 0; i < selectedFiles.length; i++) {
					formData.append('files', selectedFiles[i])
				}
			}

			setUploadProgress('Uploading to AT Protocol...')
			const response = await fetch('/wisp/upload-files', {
				method: 'POST',
				body: formData
			})

			const data = await response.json()
			if (data.success) {
				setUploadProgress('Upload complete!')
				setSkippedFiles(data.skippedFiles || [])
				setUploadedCount(data.uploadedCount || data.fileCount || 0)
				setSelectedSiteRkey('')
				setNewSiteName('')
				setSelectedFiles(null)

				// Refresh sites list
				await fetchSites()

				// Reset form - give more time if there are skipped files
				const resetDelay = data.skippedFiles && data.skippedFiles.length > 0 ? 4000 : 1500
				setTimeout(() => {
					setUploadProgress('')
					setSkippedFiles([])
					setUploadedCount(0)
					setIsUploading(false)
				}, resetDelay)
			} else {
				throw new Error(data.error || 'Upload failed')
			}
		} catch (err) {
			console.error('Upload error:', err)
			alert(
				`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`
			)
			setIsUploading(false)
			setUploadProgress('')
		}
	}

	const handleAddCustomDomain = async () => {
		if (!customDomain) {
			alert('Please enter a domain')
			return
		}

		setIsAddingDomain(true)
		try {
			const response = await fetch('/api/domain/custom/add', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domain: customDomain })
			})

			const data = await response.json()
			if (data.success) {
				setCustomDomain('')
				setAddDomainModalOpen(false)
				await fetchDomains()

				// Automatically show DNS configuration for the newly added domain
				setViewDomainDNS(data.id)
			} else {
				throw new Error(data.error || 'Failed to add domain')
			}
		} catch (err) {
			console.error('Add domain error:', err)
			alert(
				`Failed to add domain: ${err instanceof Error ? err.message : 'Unknown error'}`
			)
		} finally {
			setIsAddingDomain(false)
		}
	}

	const handleVerifyDomain = async (id: string) => {
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

	const handleDeleteCustomDomain = async (id: string) => {
		if (!confirm('Are you sure you want to remove this custom domain?')) {
			return
		}

		try {
			const response = await fetch(`/api/domain/custom/${id}`, {
				method: 'DELETE'
			})

			const data = await response.json()
			if (data.success) {
				await fetchDomains()
			} else {
				throw new Error('Failed to delete domain')
			}
		} catch (err) {
			console.error('Delete domain error:', err)
			alert(
				`Failed to delete domain: ${err instanceof Error ? err.message : 'Unknown error'}`
			)
		}
	}

	const handleConfigureSite = (site: Site) => {
		setConfiguringSite(site)

		// Determine current domain mapping
		if (wispDomain && wispDomain.rkey === site.rkey) {
			setSelectedDomain('wisp')
		} else {
			const customDomain = customDomains.find((d) => d.rkey === site.rkey)
			if (customDomain) {
				setSelectedDomain(customDomain.id)
			} else {
				setSelectedDomain('none')
			}
		}
	}

	const handleSaveSiteConfig = async () => {
		if (!configuringSite) return

		setIsSavingConfig(true)
		try {
			if (selectedDomain === 'wisp') {
				// Map to wisp.place domain
				const response = await fetch('/api/domain/wisp/map-site', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ siteRkey: configuringSite.rkey })
				})
				const data = await response.json()
				if (!data.success) throw new Error('Failed to map site')
			} else if (selectedDomain === 'none') {
				// Unmap from all domains
				// Unmap wisp domain if this site was mapped to it
				if (wispDomain && wispDomain.rkey === configuringSite.rkey) {
					await fetch('/api/domain/wisp/map-site', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ siteRkey: null })
					})
				}

				// Unmap from custom domains
				const mappedCustom = customDomains.find(
					(d) => d.rkey === configuringSite.rkey
				)
				if (mappedCustom) {
					await fetch(`/api/domain/custom/${mappedCustom.id}/map-site`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ siteRkey: null })
					})
				}
			} else {
				// Map to a custom domain
				const response = await fetch(
					`/api/domain/custom/${selectedDomain}/map-site`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ siteRkey: configuringSite.rkey })
					}
				)
				const data = await response.json()
				if (!data.success) throw new Error('Failed to map site')
			}

			// Refresh domains to get updated mappings
			await fetchDomains()
			setConfiguringSite(null)
		} catch (err) {
			console.error('Save config error:', err)
			alert(
				`Failed to save configuration: ${err instanceof Error ? err.message : 'Unknown error'}`
			)
		} finally {
			setIsSavingConfig(false)
		}
	}

	const handleDeleteSite = async () => {
		if (!configuringSite) return

		if (!confirm(`Are you sure you want to delete "${configuringSite.display_name || configuringSite.rkey}"? This action cannot be undone.`)) {
			return
		}

		setIsDeletingSite(true)
		try {
			const response = await fetch(`/api/site/${configuringSite.rkey}`, {
				method: 'DELETE'
			})

			const data = await response.json()
			if (data.success) {
				// Refresh sites list
				await fetchSites()
				// Refresh domains in case this site was mapped
				await fetchDomains()
				setConfiguringSite(null)
			} else {
				throw new Error(data.error || 'Failed to delete site')
			}
		} catch (err) {
			console.error('Delete site error:', err)
			alert(
				`Failed to delete site: ${err instanceof Error ? err.message : 'Unknown error'}`
			)
		} finally {
			setIsDeletingSite(false)
		}
	}

	const checkWispAvailability = async (handle: string) => {
		const trimmedHandle = handle.trim().toLowerCase()
		if (!trimmedHandle) {
			setWispAvailability({ available: null, checking: false })
			return
		}

		setWispAvailability({ available: null, checking: true })
		try {
			const response = await fetch(`/api/domain/check?handle=${encodeURIComponent(trimmedHandle)}`)
			const data = await response.json()
			setWispAvailability({ available: data.available, checking: false })
		} catch (err) {
			console.error('Check availability error:', err)
			setWispAvailability({ available: false, checking: false })
		}
	}

	const handleClaimWispDomain = async () => {
		const trimmedHandle = wispHandle.trim().toLowerCase()
		if (!trimmedHandle) {
			alert('Please enter a handle')
			return
		}

		setIsClaimingWisp(true)
		try {
			const response = await fetch('/api/domain/claim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ handle: trimmedHandle })
			})

			const data = await response.json()
			if (data.success) {
				setWispHandle('')
				setWispAvailability({ available: null, checking: false })
				await fetchDomains()
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
		} finally {
			setIsClaimingWisp(false)
		}
	}

	if (loading) {
		return (
			<div className="w-full min-h-screen bg-background flex items-center justify-center">
				<Loader2 className="w-8 h-8 animate-spin text-primary" />
			</div>
		)
	}

	return (
		<div className="w-full min-h-screen bg-background">
			{/* Header */}
			<header className="border-b border-border/40 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
				<div className="container mx-auto px-4 py-4 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
							<Globe className="w-5 h-5 text-primary-foreground" />
						</div>
						<span className="text-xl font-semibold text-foreground">
							wisp.place
						</span>
					</div>
					<div className="flex items-center gap-3">
						<span className="text-sm text-muted-foreground">
							{userInfo?.handle || 'Loading...'}
						</span>
					</div>
				</div>
			</header>

			<div className="container mx-auto px-4 py-8 max-w-6xl w-full">
				<div className="mb-8">
					<h1 className="text-3xl font-bold mb-2">Dashboard</h1>
					<p className="text-muted-foreground">
						Manage your sites and domains
					</p>
				</div>

				<Tabs defaultValue="sites" className="space-y-6 w-full">
					<TabsList className="grid w-full grid-cols-4">
						<TabsTrigger value="sites">Sites</TabsTrigger>
						<TabsTrigger value="domains">Domains</TabsTrigger>
						<TabsTrigger value="upload">Upload</TabsTrigger>
						<TabsTrigger value="cli">CLI</TabsTrigger>
					</TabsList>

					{/* Sites Tab */}
					<TabsContent value="sites" className="space-y-4 min-h-[400px]">
						<Card>
							<CardHeader>
								<div className="flex items-center justify-between">
									<div>
										<CardTitle>Your Sites</CardTitle>
										<CardDescription>
											View and manage all your deployed sites
										</CardDescription>
									</div>
									<Button
										variant="outline"
										size="sm"
										onClick={syncSites}
										disabled={isSyncing || sitesLoading}
									>
										<RefreshCw
											className={`w-4 h-4 mr-2 ${isSyncing ? 'animate-spin' : ''}`}
										/>
										Sync from PDS
									</Button>
								</div>
							</CardHeader>
							<CardContent className="space-y-4">
								{sitesLoading ? (
									<div className="flex items-center justify-center py-8">
										<Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
									</div>
								) : sites.length === 0 ? (
									<div className="text-center py-8 text-muted-foreground">
										<p>No sites yet. Upload your first site!</p>
									</div>
								) : (
									sites.map((site) => (
										<div
											key={`${site.did}-${site.rkey}`}
											className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-muted/50 transition-colors"
										>
											<div className="flex-1">
												<div className="flex items-center gap-3 mb-2">
													<h3 className="font-semibold text-lg">
														{site.display_name || site.rkey}
													</h3>
													<Badge
														variant="secondary"
														className="text-xs"
													>
														active
													</Badge>
												</div>
												<a
													href={getSiteUrl(site)}
													target="_blank"
													rel="noopener noreferrer"
													className="text-sm text-accent hover:text-accent/80 flex items-center gap-1"
												>
													{getSiteDomainName(site)}
													<ExternalLink className="w-3 h-3" />
												</a>
											</div>
											<Button
												variant="outline"
												size="sm"
												onClick={() => handleConfigureSite(site)}
											>
												<Settings className="w-4 h-4 mr-2" />
												Configure
											</Button>
										</div>
									))
								)}
							</CardContent>
						</Card>
					</TabsContent>

					{/* Domains Tab */}
					<TabsContent value="domains" className="space-y-4 min-h-[400px]">
						<Card>
							<CardHeader>
								<CardTitle>wisp.place Subdomain</CardTitle>
								<CardDescription>
									Your free subdomain on the wisp.place network
								</CardDescription>
							</CardHeader>
							<CardContent>
								{domainsLoading ? (
									<div className="flex items-center justify-center py-4">
										<Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
									</div>
								) : wispDomain ? (
									<>
										<div className="flex flex-col gap-2 p-4 bg-muted/50 rounded-lg">
											<div className="flex items-center gap-2">
												<CheckCircle2 className="w-5 h-5 text-green-500" />
												<span className="font-mono text-lg">
													{wispDomain.domain}
												</span>
											</div>
											{wispDomain.rkey && (
												<p className="text-xs text-muted-foreground ml-7">
													→ Mapped to site: {wispDomain.rkey}
												</p>
											)}
										</div>
										<p className="text-sm text-muted-foreground mt-3">
											{wispDomain.rkey
												? 'This domain is mapped to a specific site'
												: 'This domain is not mapped to any site yet. Configure it from the Sites tab.'}
										</p>
									</>
								) : (
									<div className="space-y-4">
										<div className="p-4 bg-muted/30 rounded-lg">
											<p className="text-sm text-muted-foreground mb-4">
												Claim your free wisp.place subdomain
											</p>
											<div className="space-y-3">
												<div className="space-y-2">
													<Label htmlFor="wisp-handle">Choose your handle</Label>
													<div className="flex gap-2">
														<div className="flex-1 relative">
															<Input
																id="wisp-handle"
																placeholder="mysite"
																value={wispHandle}
																onChange={(e) => {
																	setWispHandle(e.target.value)
																	if (e.target.value.trim()) {
																		checkWispAvailability(e.target.value)
																	} else {
																		setWispAvailability({ available: null, checking: false })
																	}
																}}
																disabled={isClaimingWisp}
																className="pr-24"
															/>
															<span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
																.wisp.place
															</span>
														</div>
													</div>
													{wispAvailability.checking && (
														<p className="text-xs text-muted-foreground flex items-center gap-1">
															<Loader2 className="w-3 h-3 animate-spin" />
															Checking availability...
														</p>
													)}
													{!wispAvailability.checking && wispAvailability.available === true && (
														<p className="text-xs text-green-600 flex items-center gap-1">
															<CheckCircle2 className="w-3 h-3" />
															Available
														</p>
													)}
													{!wispAvailability.checking && wispAvailability.available === false && (
														<p className="text-xs text-red-600 flex items-center gap-1">
															<XCircle className="w-3 h-3" />
															Not available
														</p>
													)}
												</div>
												<Button
													onClick={handleClaimWispDomain}
													disabled={!wispHandle.trim() || isClaimingWisp || wispAvailability.available !== true}
													className="w-full"
												>
													{isClaimingWisp ? (
														<>
															<Loader2 className="w-4 h-4 mr-2 animate-spin" />
															Claiming...
														</>
													) : (
														'Claim Subdomain'
													)}
												</Button>
											</div>
										</div>
									</div>
								)}
							</CardContent>
						</Card>

						<Card>
							<CardHeader>
								<CardTitle>Custom Domains</CardTitle>
								<CardDescription>
									Bring your own domain with DNS verification
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								<Button
									onClick={() => setAddDomainModalOpen(true)}
									className="w-full"
								>
									Add Custom Domain
								</Button>

								{domainsLoading ? (
									<div className="flex items-center justify-center py-4">
										<Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
									</div>
								) : customDomains.length === 0 ? (
									<div className="text-center py-4 text-muted-foreground text-sm">
										No custom domains added yet
									</div>
								) : (
									<div className="space-y-2">
										{customDomains.map((domain) => (
											<div
												key={domain.id}
												className="flex items-center justify-between p-3 border border-border rounded-lg"
											>
												<div className="flex flex-col gap-1 flex-1">
													<div className="flex items-center gap-2">
														{domain.verified ? (
															<CheckCircle2 className="w-4 h-4 text-green-500" />
														) : (
															<XCircle className="w-4 h-4 text-red-500" />
														)}
														<span className="font-mono">
															{domain.domain}
														</span>
													</div>
													{domain.rkey && domain.rkey !== 'self' && (
														<p className="text-xs text-muted-foreground ml-6">
															→ Mapped to site: {domain.rkey}
														</p>
													)}
												</div>
												<div className="flex items-center gap-2">
													<Button
														variant="outline"
														size="sm"
														onClick={() =>
															setViewDomainDNS(domain.id)
														}
													>
														View DNS
													</Button>
													{domain.verified ? (
														<Badge variant="secondary">
															Verified
														</Badge>
													) : (
														<Button
															variant="outline"
															size="sm"
															onClick={() =>
																handleVerifyDomain(domain.id)
															}
															disabled={
																verificationStatus[
																	domain.id
																] === 'verifying'
															}
														>
															{verificationStatus[
																domain.id
															] === 'verifying' ? (
																<>
																	<Loader2 className="w-3 h-3 mr-1 animate-spin" />
																	Verifying...
																</>
															) : (
																'Verify DNS'
															)}
														</Button>
													)}
													<Button
														variant="ghost"
														size="sm"
														onClick={() =>
															handleDeleteCustomDomain(
																domain.id
															)
														}
													>
														<Trash2 className="w-4 h-4" />
													</Button>
												</div>
											</div>
										))}
									</div>
								)}
							</CardContent>
						</Card>
					</TabsContent>

					{/* Upload Tab */}
					<TabsContent value="upload" className="space-y-4 min-h-[400px]">
						<Card>
							<CardHeader>
								<CardTitle>Upload Site</CardTitle>
								<CardDescription>
									Deploy a new site from a folder or Git repository
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-6">
								<div className="space-y-4">
									<div className="p-4 bg-muted/50 rounded-lg">
										<RadioGroup
											value={siteMode}
											onValueChange={(value) => setSiteMode(value as 'existing' | 'new')}
											disabled={isUploading}
										>
											<div className="flex items-center space-x-2">
												<RadioGroupItem value="existing" id="existing" />
												<Label htmlFor="existing" className="cursor-pointer">
													Update existing site
												</Label>
											</div>
											<div className="flex items-center space-x-2">
												<RadioGroupItem value="new" id="new" />
												<Label htmlFor="new" className="cursor-pointer">
													Create new site
												</Label>
											</div>
										</RadioGroup>
									</div>

									{siteMode === 'existing' ? (
										<div className="space-y-2">
											<Label htmlFor="site-select">Select Site</Label>
											{sitesLoading ? (
												<div className="flex items-center justify-center py-4">
													<Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
												</div>
											) : sites.length === 0 ? (
												<div className="p-4 border border-dashed rounded-lg text-center text-sm text-muted-foreground">
													No sites available. Create a new site instead.
												</div>
											) : (
												<select
													id="site-select"
													className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
													value={selectedSiteRkey}
													onChange={(e) => setSelectedSiteRkey(e.target.value)}
													disabled={isUploading}
												>
													<option value="">Select a site...</option>
													{sites.map((site) => (
														<option key={site.rkey} value={site.rkey}>
															{site.display_name || site.rkey}
														</option>
													))}
												</select>
											)}
										</div>
									) : (
										<div className="space-y-2">
											<Label htmlFor="new-site-name">New Site Name</Label>
											<Input
												id="new-site-name"
												placeholder="my-awesome-site"
												value={newSiteName}
												onChange={(e) => setNewSiteName(e.target.value)}
												disabled={isUploading}
											/>
										</div>
									)}

									<p className="text-xs text-muted-foreground">
										File limits: 100MB per file, 300MB total
									</p>
								</div>

								<div className="grid md:grid-cols-2 gap-4">
									<Card className="border-2 border-dashed hover:border-accent transition-colors cursor-pointer">
										<CardContent className="flex flex-col items-center justify-center p-8 text-center">
											<Upload className="w-12 h-12 text-muted-foreground mb-4" />
											<h3 className="font-semibold mb-2">
												Upload Folder
											</h3>
											<p className="text-sm text-muted-foreground mb-4">
												Drag and drop or click to upload your
												static site files
											</p>
											<input
												type="file"
												id="file-upload"
												multiple
												onChange={handleFileSelect}
												className="hidden"
												{...(({ webkitdirectory: '', directory: '' } as any))}
												disabled={isUploading}
											/>
											<label htmlFor="file-upload">
												<Button
													variant="outline"
													type="button"
													onClick={() =>
														document
															.getElementById('file-upload')
															?.click()
													}
													disabled={isUploading}
												>
													Choose Folder
												</Button>
											</label>
											{selectedFiles && selectedFiles.length > 0 && (
												<p className="text-sm text-muted-foreground mt-3">
													{selectedFiles.length} files selected
												</p>
											)}
										</CardContent>
									</Card>

									<Card className="border-2 border-dashed opacity-50">
										<CardContent className="flex flex-col items-center justify-center p-8 text-center">
											<Globe className="w-12 h-12 text-muted-foreground mb-4" />
											<h3 className="font-semibold mb-2">
												Connect Git Repository
											</h3>
											<p className="text-sm text-muted-foreground mb-4">
												Link your GitHub, GitLab, or any Git
												repository
											</p>
											<Badge variant="secondary">Coming soon!</Badge>
										</CardContent>
									</Card>
								</div>

								{uploadProgress && (
									<div className="space-y-3">
										<div className="p-4 bg-muted rounded-lg">
											<div className="flex items-center gap-2">
												<Loader2 className="w-4 h-4 animate-spin" />
												<span className="text-sm">{uploadProgress}</span>
											</div>
										</div>

										{skippedFiles.length > 0 && (
											<div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
												<div className="flex items-start gap-2 text-yellow-600 dark:text-yellow-400 mb-2">
													<AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
													<div className="flex-1">
														<span className="font-medium">
															{skippedFiles.length} file{skippedFiles.length > 1 ? 's' : ''} skipped
														</span>
														{uploadedCount > 0 && (
															<span className="text-sm ml-2">
																({uploadedCount} uploaded successfully)
															</span>
														)}
													</div>
												</div>
												<div className="ml-6 space-y-1 max-h-32 overflow-y-auto">
													{skippedFiles.slice(0, 5).map((file, idx) => (
														<div key={idx} className="text-xs">
															<span className="font-mono">{file.name}</span>
															<span className="text-muted-foreground"> - {file.reason}</span>
														</div>
													))}
													{skippedFiles.length > 5 && (
														<div className="text-xs text-muted-foreground">
															...and {skippedFiles.length - 5} more
														</div>
													)}
												</div>
											</div>
										)}
									</div>
								)}

								<Button
									onClick={handleUpload}
									className="w-full"
									disabled={
										(siteMode === 'existing' ? !selectedSiteRkey : !newSiteName) ||
										isUploading ||
										(siteMode === 'existing' && (!selectedFiles || selectedFiles.length === 0))
									}
								>
									{isUploading ? (
										<>
											<Loader2 className="w-4 h-4 mr-2 animate-spin" />
											Uploading...
										</>
									) : (
										<>
											{siteMode === 'existing' ? (
												'Update Site'
											) : (
												selectedFiles && selectedFiles.length > 0
													? 'Upload & Deploy'
													: 'Create Empty Site'
											)}
										</>
									)}
								</Button>
							</CardContent>
						</Card>
					</TabsContent>

					{/* CLI Tab */}
					<TabsContent value="cli" className="space-y-4 min-h-[400px]">
						<Card>
							<CardHeader>
								<div className="flex items-center gap-2 mb-2">
									<CardTitle>Wisp CLI Tool</CardTitle>
									<Badge variant="secondary" className="text-xs">v0.1.0</Badge>
									<Badge variant="outline" className="text-xs">Alpha</Badge>
								</div>
								<CardDescription>
									Deploy static sites directly from your terminal
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-6">
								<div className="prose prose-sm max-w-none dark:prose-invert">
									<p className="text-sm text-muted-foreground">
										The Wisp CLI is a command-line tool for deploying static websites directly to your AT Protocol account.
										Authenticate with app password or OAuth and deploy from CI/CD pipelines.
									</p>
								</div>

								<div className="space-y-3">
									<h3 className="text-sm font-semibold">Download CLI</h3>
									<div className="grid gap-2">
										<div className="p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border">
											<a
												href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-macos-arm64"
												target="_blank"
												rel="noopener noreferrer"
												className="flex items-center justify-between mb-2"
											>
												<span className="font-mono text-sm">macOS (Apple Silicon)</span>
												<ExternalLink className="w-4 h-4 text-muted-foreground" />
											</a>
											<div className="text-xs text-muted-foreground">
												<span className="font-mono">SHA256: 637e325d9668ca745e01493d80dfc72447ef0a889b313e28913ca65c94c7aaae</span>
											</div>
										</div>
										<div className="p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border">
											<a
												href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-aarch64-linux"
												target="_blank"
												rel="noopener noreferrer"
												className="flex items-center justify-between mb-2"
											>
												<span className="font-mono text-sm">Linux (ARM64)</span>
												<ExternalLink className="w-4 h-4 text-muted-foreground" />
											</a>
											<div className="text-xs text-muted-foreground">
												<span className="font-mono">SHA256: 01561656b64826f95b39f13c65c97da8bcc63ecd9f4d7e4e369c8ba8c903c22a</span>
											</div>
										</div>
										<div className="p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border">
											<a
												href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux"
												target="_blank"
												rel="noopener noreferrer"
												className="flex items-center justify-between mb-2"
											>
												<span className="font-mono text-sm">Linux (x86_64)</span>
												<ExternalLink className="w-4 h-4 text-muted-foreground" />
											</a>
											<div className="text-xs text-muted-foreground">
												<span className="font-mono">SHA256: 1ff485b9bcf89bc5721a862863c4843cf4530cbcd2489cf200cb24a44f7865a2</span>
											</div>
										</div>
									</div>
								</div>

								<div className="space-y-3">
									<h3 className="text-sm font-semibold">Basic Usage</h3>
									<CodeBlock
										code={`# Download and make executable
curl -O https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-macos-arm64
chmod +x wisp-cli-macos-arm64

# Deploy your site (will use OAuth)
./wisp-cli-macos-arm64 your-handle.bsky.social \\
  --path ./dist \\
  --site my-site

# Your site will be available at:
# https://sites.wisp.place/your-handle/my-site`}
										language="bash"
									/>
								</div>

								<div className="space-y-3">
									<h3 className="text-sm font-semibold">CI/CD with Tangled Spindle</h3>
									<p className="text-xs text-muted-foreground">
										Deploy automatically on every push using{' '}
										<a
											href="https://blog.tangled.org/ci"
											target="_blank"
											rel="noopener noreferrer"
											className="text-accent hover:underline"
										>
											Tangled Spindle
										</a>
									</p>

									<div className="space-y-4">
										<div>
											<h4 className="text-xs font-semibold mb-2 flex items-center gap-2">
												<span>Example 1: Simple Asset Publishing</span>
												<Badge variant="secondary" className="text-xs">Copy Files</Badge>
											</h4>
											<CodeBlock
												code={`when:
  - event: ['push']
    branch: ['main']
  - event: ['manual']

engine: 'nixery'

clone:
  skip: false
  depth: 1

dependencies:
  nixpkgs:
    - coreutils
    - curl

environment:
  SITE_PATH: '.'  # Copy entire repo
  SITE_NAME: 'myWebbedSite'
  WISP_HANDLE: 'your-handle.bsky.social'

steps:
  - name: deploy assets to wisp
    command: |
      # Download Wisp CLI
      curl https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli

      # Deploy to Wisp
      ./wisp-cli \\
        "$WISP_HANDLE" \\
        --path "$SITE_PATH" \\
        --site "$SITE_NAME" \\
        --password "$WISP_APP_PASSWORD"

      # Output
      #Deployed site 'myWebbedSite': at://did:plc:ttdrpj45ibqunmfhdsb4zdwq/place.wisp.fs/myWebbedSite
      #Available at: https://sites.wisp.place/did:plc:ttdrpj45ibqunmfhdsb4zdwq/myWebbedSite
        `}
												language="yaml"
											/>
										</div>

										<div>
											<h4 className="text-xs font-semibold mb-2 flex items-center gap-2">
												<span>Example 2: React/Vite Build & Deploy</span>
												<Badge variant="secondary" className="text-xs">Full Build</Badge>
											</h4>
											<CodeBlock
												code={`when:
  - event: ['push']
    branch: ['main']
  - event: ['manual']

engine: 'nixery'

clone:
  skip: false
  depth: 1
  submodules: false

dependencies:
  nixpkgs:
    - nodejs
    - coreutils
    - curl
  github:NixOS/nixpkgs/nixpkgs-unstable:
    - bun

environment:
  SITE_PATH: 'dist'
  SITE_NAME: 'my-react-site'
  WISP_HANDLE: 'your-handle.bsky.social'

steps:
  - name: build site
    command: |
      export PATH="$HOME/.nix-profile/bin:$PATH"

      # regenerate lockfile
      rm package-lock.json bun.lock
      bun install @rolldown/binding-linux-arm64-gnu --save-optional
      bun install

      # build with vite
      bun node_modules/.bin/vite build

  - name: deploy to wisp
    command: |
      # Download Wisp CLI
      curl https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli

      # Deploy to Wisp
      ./wisp-cli \\
        "$WISP_HANDLE" \\
        --path "$SITE_PATH" \\
        --site "$SITE_NAME" \\
        --password "$WISP_APP_PASSWORD"`}
												language="yaml"
											/>
										</div>
									</div>

									<div className="p-3 bg-muted/30 rounded-lg border-l-4 border-accent">
										<p className="text-xs text-muted-foreground">
											<strong className="text-foreground">Note:</strong> Set <code className="px-1.5 py-0.5 bg-background rounded text-xs">WISP_APP_PASSWORD</code> as a secret in your Tangled Spindle repository settings.
											Generate an app password from your AT Protocol account settings.
										</p>
									</div>
								</div>

								<div className="space-y-3">
									<h3 className="text-sm font-semibold">Learn More</h3>
									<div className="grid gap-2">
										<a
											href="https://tangled.org/@nekomimi.pet/wisp.place-monorepo/tree/main/cli"
											target="_blank"
											rel="noopener noreferrer"
											className="flex items-center justify-between p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border"
										>
											<span className="text-sm">Source Code</span>
											<ExternalLink className="w-4 h-4 text-muted-foreground" />
										</a>
										<a
											href="https://blog.tangled.org/ci"
											target="_blank"
											rel="noopener noreferrer"
											className="flex items-center justify-between p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border"
										>
											<span className="text-sm">Tangled Spindle CI/CD</span>
											<ExternalLink className="w-4 h-4 text-muted-foreground" />
										</a>
									</div>
								</div>
							</CardContent>
						</Card>
					</TabsContent>
				</Tabs>
			</div>

			{/* Add Custom Domain Modal */}
			<Dialog open={addDomainModalOpen} onOpenChange={setAddDomainModalOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Add Custom Domain</DialogTitle>
						<DialogDescription>
							Enter your domain name. After adding, you'll see the DNS
							records to configure.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Label htmlFor="new-domain">Domain Name</Label>
							<Input
								id="new-domain"
								placeholder="example.com"
								value={customDomain}
								onChange={(e) => setCustomDomain(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								After adding, click "View DNS" to see the records you
								need to configure.
							</p>
						</div>
					</div>
					<DialogFooter className="flex-col sm:flex-row gap-2">
						<Button
							variant="outline"
							onClick={() => {
								setAddDomainModalOpen(false)
								setCustomDomain('')
							}}
							className="w-full sm:w-auto"
							disabled={isAddingDomain}
						>
							Cancel
						</Button>
						<Button
							onClick={handleAddCustomDomain}
							disabled={!customDomain || isAddingDomain}
							className="w-full sm:w-auto"
						>
							{isAddingDomain ? (
								<>
									<Loader2 className="w-4 h-4 mr-2 animate-spin" />
									Adding...
								</>
							) : (
								'Add Domain'
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Site Configuration Modal */}
			<Dialog
				open={configuringSite !== null}
				onOpenChange={(open) => !open && setConfiguringSite(null)}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Configure Site Domain</DialogTitle>
						<DialogDescription>
							Choose which domain this site should use
						</DialogDescription>
					</DialogHeader>
					{configuringSite && (
						<div className="space-y-4 py-4">
							<div className="p-3 bg-muted/30 rounded-lg">
								<p className="text-sm font-medium mb-1">Site:</p>
								<p className="font-mono text-sm">
									{configuringSite.display_name ||
										configuringSite.rkey}
								</p>
							</div>

							<RadioGroup
								value={selectedDomain}
								onValueChange={setSelectedDomain}
							>
								{wispDomain && (
									<div className="flex items-center space-x-2">
										<RadioGroupItem value="wisp" id="wisp" />
										<Label
											htmlFor="wisp"
											className="flex-1 cursor-pointer"
										>
											<div className="flex items-center justify-between">
												<span className="font-mono text-sm">
													{wispDomain.domain}
												</span>
												<Badge variant="secondary" className="text-xs ml-2">
													Free
												</Badge>
											</div>
										</Label>
									</div>
								)}

								{customDomains
									.filter((d) => d.verified)
									.map((domain) => (
										<div
											key={domain.id}
											className="flex items-center space-x-2"
										>
											<RadioGroupItem
												value={domain.id}
												id={domain.id}
											/>
											<Label
												htmlFor={domain.id}
												className="flex-1 cursor-pointer"
											>
												<div className="flex items-center justify-between">
													<span className="font-mono text-sm">
														{domain.domain}
													</span>
													<Badge
														variant="outline"
														className="text-xs ml-2"
													>
														Custom
													</Badge>
												</div>
											</Label>
										</div>
									))}

								<div className="flex items-center space-x-2">
									<RadioGroupItem value="none" id="none" />
									<Label htmlFor="none" className="flex-1 cursor-pointer">
										<div className="flex flex-col">
											<span className="text-sm">Default URL</span>
											<span className="text-xs text-muted-foreground font-mono break-all">
												sites.wisp.place/{configuringSite.did}/
												{configuringSite.rkey}
											</span>
										</div>
									</Label>
								</div>
							</RadioGroup>
						</div>
					)}
					<DialogFooter className="flex flex-col sm:flex-row sm:justify-between gap-2">
						<Button
							variant="destructive"
							onClick={handleDeleteSite}
							disabled={isSavingConfig || isDeletingSite}
							className="sm:mr-auto"
						>
							{isDeletingSite ? (
								<>
									<Loader2 className="w-4 h-4 mr-2 animate-spin" />
									Deleting...
								</>
							) : (
								<>
									<Trash2 className="w-4 h-4 mr-2" />
									Delete Site
								</>
							)}
						</Button>
						<div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
							<Button
								variant="outline"
								onClick={() => setConfiguringSite(null)}
								disabled={isSavingConfig || isDeletingSite}
								className="w-full sm:w-auto"
							>
								Cancel
							</Button>
							<Button
								onClick={handleSaveSiteConfig}
								disabled={isSavingConfig || isDeletingSite}
								className="w-full sm:w-auto"
							>
								{isSavingConfig ? (
									<>
										<Loader2 className="w-4 h-4 mr-2 animate-spin" />
										Saving...
									</>
								) : (
									'Save'
								)}
							</Button>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* View DNS Records Modal */}
			<Dialog
				open={viewDomainDNS !== null}
				onOpenChange={(open) => !open && setViewDomainDNS(null)}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>DNS Configuration</DialogTitle>
						<DialogDescription>
							Add these DNS records to your domain provider
						</DialogDescription>
					</DialogHeader>
					{viewDomainDNS && userInfo && (
						<>
							{(() => {
								const domain = customDomains.find(
									(d) => d.id === viewDomainDNS
								)
								if (!domain) return null

								return (
									<div className="space-y-4 py-4">
										<div className="p-3 bg-muted/30 rounded-lg">
											<p className="text-sm font-medium mb-1">
												Domain:
											</p>
											<p className="font-mono text-sm">
												{domain.domain}
											</p>
										</div>

										<div className="space-y-3">
											<div className="p-3 bg-background rounded border border-border">
												<div className="flex justify-between items-start mb-2">
													<span className="text-xs font-semibold text-muted-foreground">
														TXT Record (Verification)
													</span>
												</div>
												<div className="font-mono text-xs space-y-2">
													<div>
														<span className="text-muted-foreground">
															Name:
														</span>{' '}
														<span className="select-all">
															_wisp.{domain.domain}
														</span>
													</div>
													<div>
														<span className="text-muted-foreground">
															Value:
														</span>{' '}
														<span className="select-all break-all">
															{userInfo.did}
														</span>
													</div>
												</div>
											</div>

											<div className="p-3 bg-background rounded border border-border">
												<div className="flex justify-between items-start mb-2">
													<span className="text-xs font-semibold text-muted-foreground">
														CNAME Record (Pointing)
													</span>
												</div>
												<div className="font-mono text-xs space-y-2">
													<div>
														<span className="text-muted-foreground">
															Name:
														</span>{' '}
														<span className="select-all">
															{domain.domain}
														</span>
													</div>
													<div>
														<span className="text-muted-foreground">
															Value:
														</span>{' '}
														<span className="select-all">
															{domain.id}.dns.wisp.place
														</span>
													</div>
												</div>
												<p className="text-xs text-muted-foreground mt-2">
													Some DNS providers may require you to use @ or leave it blank for the root domain
												</p>
											</div>
										</div>

										<div className="p-3 bg-muted/30 rounded-lg">
											<p className="text-xs text-muted-foreground">
												💡 After configuring DNS, click "Verify DNS"
												to check if everything is set up correctly.
												DNS changes can take a few minutes to
												propagate.
											</p>
										</div>
									</div>
								)
							})()}
						</>
					)}
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setViewDomainDNS(null)}
							className="w-full sm:w-auto"
						>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

const root = createRoot(document.getElementById('elysia')!)
root.render(
	<Layout className="gap-6">
		<Dashboard />
	</Layout>
)
