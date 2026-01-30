import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Link, useNavigate } from 'react-router-dom'
import { Button } from '@public/components/ui/button'
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger
} from '@public/components/ui/tabs'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter
} from '@public/components/ui/dialog'
import { Checkbox } from '@public/components/ui/checkbox'
import { Label } from '@public/components/ui/label'
import { Badge } from '@public/components/ui/badge'
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import { Input } from '@public/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@public/components/ui/radio-group'
import { Card } from '@public/components/ui/card'
import {
	Loader2,
	Trash2,
	LogOut,
	ArrowLeft,
	Shield,
	AlertCircle,
	CheckCircle,
	Scale
} from 'lucide-react'
import Layout from '@public/layouts'
import { useUserInfo } from './hooks/useUserInfo'
import { useSiteData, type SiteWithDomains } from './hooks/useSiteData'
import { useDomainData } from './hooks/useDomainData'
import { SitesTab } from './tabs/SitesTab'
import { DomainsTab } from './tabs/DomainsTab'
import { UploadTab } from './tabs/UploadTab'
import { CLITab } from './tabs/CLITab'

function Dashboard() {
	// Use custom hooks
	const { userInfo, loading, fetchUserInfo } = useUserInfo()
	const { sites, sitesLoading, isSyncing, fetchSites, syncSites, deleteSite } = useSiteData()
	const {
		wispDomains,
		customDomains,
		domainsLoading,
		verificationStatus,
		fetchDomains,
		addCustomDomain,
		verifyDomain,
		deleteCustomDomain,
		mapWispDomain,
		deleteWispDomain,
		mapCustomDomain,
		claimWispDomain,
		checkWispAvailability
	} = useDomainData()

	// Site configuration modal state (shared across components)
	const [configuringSite, setConfiguringSite] = useState<SiteWithDomains | null>(null)
	const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set())
	const [isSavingConfig, setIsSavingConfig] = useState(false)
	const [isDeletingSite, setIsDeletingSite] = useState(false)

	// Site settings state
	type RoutingMode = 'default' | 'spa' | 'directory' | 'custom404'
	const [routingMode, setRoutingMode] = useState<RoutingMode>('default')
	const [spaFile, setSpaFile] = useState('index.html')
	const [custom404File, setCustom404File] = useState('404.html')
	const [indexFiles, setIndexFiles] = useState<string[]>(['index.html'])
	const [newIndexFile, setNewIndexFile] = useState('')
	const [cleanUrls, setCleanUrls] = useState(false)
	const [corsEnabled, setCorsEnabled] = useState(false)
	const [corsOrigin, setCorsOrigin] = useState('*')

	// Fetch initial data on mount
	useEffect(() => {
		fetchUserInfo()
		fetchSites()
		fetchDomains()
	}, [])

	// Handle site configuration modal
	const handleConfigureSite = async (site: SiteWithDomains) => {
		setConfiguringSite(site)

		// Build set of currently mapped domains
		const mappedDomains = new Set<string>()

		if (site.domains) {
			site.domains.forEach(domainInfo => {
				if (domainInfo.type === 'wisp') {
					// For wisp domains, use the domain itself as the identifier
					mappedDomains.add(`wisp:${domainInfo.domain}`)
				} else if (domainInfo.id) {
					mappedDomains.add(domainInfo.id)
				}
			})
		}

		setSelectedDomains(mappedDomains)

		// Fetch and populate settings for this site
		try {
			const response = await fetch(`/api/site/${site.rkey}/settings`, {
				credentials: 'include'
			})
			if (response.ok) {
				const settings = await response.json()

				// Determine routing mode based on settings
				if (settings.spaMode) {
					setRoutingMode('spa')
					setSpaFile(settings.spaMode)
				} else if (settings.directoryListing) {
					setRoutingMode('directory')
				} else if (settings.custom404) {
					setRoutingMode('custom404')
					setCustom404File(settings.custom404)
				} else {
					setRoutingMode('default')
				}

				// Set other settings
				setIndexFiles(settings.indexFiles || ['index.html'])
				setCleanUrls(settings.cleanUrls || false)

				// Check for CORS headers
				const corsHeader = settings.headers?.find((h: any) => h.name === 'Access-Control-Allow-Origin')
				if (corsHeader) {
					setCorsEnabled(true)
					setCorsOrigin(corsHeader.value)
				} else {
					setCorsEnabled(false)
					setCorsOrigin('*')
				}
			} else {
				// Reset to defaults if no settings found
				setRoutingMode('default')
				setSpaFile('index.html')
				setCustom404File('404.html')
				setIndexFiles(['index.html'])
				setCleanUrls(false)
				setCorsEnabled(false)
				setCorsOrigin('*')
			}
		} catch (err) {
			console.error('Failed to fetch settings:', err)
			// Use defaults on error
			setRoutingMode('default')
			setSpaFile('index.html')
			setCustom404File('404.html')
			setIndexFiles(['index.html'])
			setCleanUrls(false)
			setCorsEnabled(false)
			setCorsOrigin('*')
		}
	}

	const handleSaveSiteConfig = async () => {
		if (!configuringSite) return

		setIsSavingConfig(true)
		try {
			// Handle wisp domain mappings
			const selectedWispDomainIds = Array.from(selectedDomains).filter(id => id.startsWith('wisp:'))
			const selectedWispDomains = selectedWispDomainIds.map(id => id.replace('wisp:', ''))

			// Get currently mapped wisp domains
			const currentlyMappedWispDomains = wispDomains.filter(
				d => d.rkey === configuringSite.rkey
			)

			// Unmap wisp domains that are no longer selected
			for (const domain of currentlyMappedWispDomains) {
				if (!selectedWispDomains.includes(domain.domain)) {
					await mapWispDomain(domain.domain, null)
				}
			}

			// Map newly selected wisp domains
			for (const domainName of selectedWispDomains) {
				const isAlreadyMapped = currentlyMappedWispDomains.some(d => d.domain === domainName)
				if (!isAlreadyMapped) {
					await mapWispDomain(domainName, configuringSite.rkey)
				}
			}

			// Handle custom domain mappings
			const selectedCustomDomainIds = Array.from(selectedDomains).filter(id => !id.startsWith('wisp:'))
			const currentlyMappedCustomDomains = customDomains.filter(
				d => d.rkey === configuringSite.rkey
			)

			// Unmap domains that are no longer selected
			for (const domain of currentlyMappedCustomDomains) {
				if (!selectedCustomDomainIds.includes(domain.id)) {
					await mapCustomDomain(domain.id, null)
				}
			}

			// Map newly selected domains
			for (const domainId of selectedCustomDomainIds) {
				const isAlreadyMapped = currentlyMappedCustomDomains.some(d => d.id === domainId)
				if (!isAlreadyMapped) {
					await mapCustomDomain(domainId, configuringSite.rkey)
				}
			}

			// Save site settings
			const settings: any = {
				cleanUrls,
				indexFiles: indexFiles.filter(f => f.trim() !== '')
			}

			// Set routing mode based on selection
			if (routingMode === 'spa') {
				settings.spaMode = spaFile
			} else if (routingMode === 'directory') {
				settings.directoryListing = true
			} else if (routingMode === 'custom404') {
				settings.custom404 = custom404File
			}

			// Add CORS header if enabled
			if (corsEnabled) {
				settings.headers = [
					{
						name: 'Access-Control-Allow-Origin',
						value: corsOrigin
					}
				]
			}

			const settingsResponse = await fetch(`/api/site/${configuringSite.rkey}/settings`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				credentials: 'include',
				body: JSON.stringify(settings)
			})

			if (!settingsResponse.ok) {
				const error = await settingsResponse.json()
				throw new Error(error.error || 'Failed to save settings')
			}

			// Refresh both domains and sites to get updated mappings
			await fetchDomains()
			await fetchSites()
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
		const success = await deleteSite(configuringSite.rkey)
		if (success) {
			// Refresh domains in case this site was mapped
			await fetchDomains()
			setConfiguringSite(null)
		}
		setIsDeletingSite(false)
	}

	const handleUploadComplete = async () => {
		await fetchSites()
	}

	const handleLogout = async () => {
		try {
			const response = await fetch('/api/auth/logout', {
				method: 'POST',
				credentials: 'include'
			})
			const result = await response.json()
			if (result.success) {
				// Redirect to home page after successful logout
				window.location.href = '/'
			} else {
				alert('Logout failed: ' + (result.error || 'Unknown error'))
			}
		} catch (err) {
			alert('Logout failed: ' + (err instanceof Error ? err.message : 'Unknown error'))
		}
	}

	if (loading) {
		return (
			<div className="w-full min-h-screen bg-background">
				{/* Header Skeleton */}
				<header className="w-full border-b border-border/40 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
					<div className="max-w-6xl w-full mx-auto px-4 h-16 flex items-center justify-between">
						<div className="flex items-center gap-2">
							<img src="/transparent-full-size-ico.png" alt="wisp.place" className="w-8 h-8" />
							<span className="text-xl font-semibold text-foreground">
								wisp.place
							</span>
						</div>
						<div className="flex items-center gap-3">
							<SkeletonShimmer className="h-5 w-32" />
							<SkeletonShimmer className="h-8 w-8 rounded" />
						</div>
					</div>
				</header>

				<div className="container mx-auto px-4 py-8 max-w-6xl w-full">
					{/* Title Skeleton */}
					<div className="mb-8 space-y-2">
						<SkeletonShimmer className="h-9 w-48" />
						<SkeletonShimmer className="h-5 w-64" />
					</div>

					{/* Tabs Skeleton */}
					<div className="space-y-6 w-full">
						<div className="inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground w-full">
							<SkeletonShimmer className="h-8 w-1/4 mx-1" />
							<SkeletonShimmer className="h-8 w-1/4 mx-1" />
							<SkeletonShimmer className="h-8 w-1/4 mx-1" />
							<SkeletonShimmer className="h-8 w-1/4 mx-1" />
						</div>

						{/* Content Skeleton */}
						<div className="space-y-4">
							<div className="rounded-lg border border-border bg-card text-card-foreground shadow-sm">
								<div className="flex flex-col space-y-1.5 p-6">
									<SkeletonShimmer className="h-7 w-40" />
									<SkeletonShimmer className="h-4 w-64" />
								</div>
								<div className="p-6 pt-0 space-y-4">
									{[...Array(3)].map((_, i) => (
										<div
											key={i}
											className="flex items-center justify-between p-4 border border-border rounded-lg"
										>
											<div className="flex-1 space-y-3">
												<div className="flex items-center gap-3">
													<SkeletonShimmer className="h-6 w-48" />
													<SkeletonShimmer className="h-5 w-16" />
												</div>
												<SkeletonShimmer className="h-4 w-64" />
											</div>
											<SkeletonShimmer className="h-9 w-28" />
										</div>
									))}
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		)
	}

	return (
		<div className="w-full min-h-screen bg-background flex flex-col">
			{/* Header */}
			<header className="w-full border-b border-border/40 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
				<div className="max-w-6xl w-full mx-auto px-4 h-16 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<img src="/transparent-full-size-ico.png" alt="wisp.place" className="w-8 h-8" />
						<span className="text-xl font-semibold text-foreground">
							wisp.place
						</span>
					</div>
					<div className="flex items-center gap-3">
						<span className="text-sm text-muted-foreground">
							{userInfo?.handle || 'Loading...'}
						</span>
						<Button
							variant="ghost"
							size="sm"
							onClick={handleLogout}
							className="h-8 px-2"
						>
							<LogOut className="w-4 h-4" />
						</Button>
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
					<TabsContent value="sites">
						<SitesTab
							sites={sites}
							sitesLoading={sitesLoading}
							isSyncing={isSyncing}
							userInfo={userInfo}
							onSyncSites={syncSites}
							onConfigureSite={handleConfigureSite}
						/>
					</TabsContent>

					{/* Domains Tab */}
					<TabsContent value="domains">
						<DomainsTab
							wispDomains={wispDomains}
							customDomains={customDomains}
							domainsLoading={domainsLoading}
							verificationStatus={verificationStatus}
							userInfo={userInfo}
							onAddCustomDomain={addCustomDomain}
							onVerifyDomain={verifyDomain}
							onDeleteCustomDomain={deleteCustomDomain}
							onDeleteWispDomain={deleteWispDomain}
							onClaimWispDomain={claimWispDomain}
							onCheckWispAvailability={checkWispAvailability}
						/>
					</TabsContent>

					{/* Upload Tab */}
					<TabsContent value="upload">
						<UploadTab
							sites={sites}
							sitesLoading={sitesLoading}
							onUploadComplete={handleUploadComplete}
						/>
					</TabsContent>

					{/* CLI Tab */}
					<TabsContent value="cli">
						<CLITab />
					</TabsContent>
				</Tabs>
			</div>

			{/* Footer */}
			<footer className="border-t border-border/40 bg-muted/20 mt-auto">
				<div className="container mx-auto px-4 py-8">
					<div className="text-center text-sm text-muted-foreground">
						<p>
							Built by{' '}
							<a
								href="https://bsky.app/profile/nekomimi.pet"
								target="_blank"
								rel="noopener noreferrer"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								@nekomimi.pet
							</a>
							{' • '}
							Contact:{' '}
							<a
								href="mailto:contact@wisp.place"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								contact@wisp.place
							</a>
							{' • '}
							Legal/DMCA:{' '}
							<a
								href="mailto:legal@wisp.place"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								legal@wisp.place
							</a>
						</p>
						<p className="mt-2">
							<Link
								to="/editor/acceptable-use"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								Acceptable Use Policy
							</Link>
						</p>
					</div>
				</div>
			</footer>

			{/* Site Configuration Modal */}
			<Dialog
				open={configuringSite !== null}
				onOpenChange={(open) => !open && setConfiguringSite(null)}
			>
				<DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Configure Site</DialogTitle>
						<DialogDescription>
							Configure domains and settings for this site.
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

							<Tabs defaultValue="domains" className="w-full">
								<TabsList className="grid w-full grid-cols-2">
									<TabsTrigger value="domains">Domains</TabsTrigger>
									<TabsTrigger value="settings">Settings</TabsTrigger>
								</TabsList>

								{/* Domains Tab */}
								<TabsContent value="domains" className="space-y-3 mt-4">
									<p className="text-sm font-medium">Available Domains:</p>

									{wispDomains.map((wispDomain) => {
										const domainId = `wisp:${wispDomain.domain}`
										return (
											<div key={domainId} className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/30">
												<Checkbox
													id={domainId}
													checked={selectedDomains.has(domainId)}
													onCheckedChange={(checked) => {
														const newSelected = new Set(selectedDomains)
														if (checked) {
															newSelected.add(domainId)
														} else {
															newSelected.delete(domainId)
														}
														setSelectedDomains(newSelected)
													}}
												/>
												<Label
													htmlFor={domainId}
													className="flex-1 cursor-pointer"
												>
													<div className="flex items-center justify-between">
														<span className="font-mono text-sm">
															{wispDomain.domain}
														</span>
														<Badge variant="secondary" className="text-xs ml-2">
															Wisp
														</Badge>
													</div>
												</Label>
											</div>
										)
									})}

									{customDomains
										.filter((d) => d.verified)
										.map((domain) => (
											<div
												key={domain.id}
												className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/30"
											>
												<Checkbox
													id={domain.id}
													checked={selectedDomains.has(domain.id)}
													onCheckedChange={(checked) => {
														const newSelected = new Set(selectedDomains)
														if (checked) {
															newSelected.add(domain.id)
														} else {
															newSelected.delete(domain.id)
														}
														setSelectedDomains(newSelected)
													}}
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

									{customDomains.filter(d => d.verified).length === 0 && wispDomains.length === 0 && (
										<p className="text-sm text-muted-foreground py-4 text-center">
											No domains available. Add a custom domain or claim a wisp.place subdomain.
										</p>
									)}

									<div className="p-3 bg-muted/20 rounded-lg border-l-4 border-blue-500/50 mt-4">
										<p className="text-xs text-muted-foreground">
											<strong>Note:</strong> If no domains are selected, the site will be accessible at:{' '}
											<span className="font-mono">
												sites.wisp.place/{userInfo?.handle || '...'}/{configuringSite.rkey}
											</span>
										</p>
									</div>
								</TabsContent>

								{/* Settings Tab */}
								<TabsContent value="settings" className="space-y-4 mt-4">
									{/* Routing Mode */}
									<div className="space-y-3">
										<Label className="text-sm font-medium">Routing Mode</Label>
										<RadioGroup value={routingMode} onValueChange={(value) => setRoutingMode(value as RoutingMode)}>
											<div className="flex items-center space-x-3 p-3 border rounded-lg">
												<RadioGroupItem value="default" id="mode-default" />
												<Label htmlFor="mode-default" className="flex-1 cursor-pointer">
													<div>
														<p className="font-medium">Default</p>
														<p className="text-xs text-muted-foreground">Standard static file serving</p>
													</div>
												</Label>
											</div>
											<div className="flex items-center space-x-3 p-3 border rounded-lg">
												<RadioGroupItem value="spa" id="mode-spa" />
												<Label htmlFor="mode-spa" className="flex-1 cursor-pointer">
													<div>
														<p className="font-medium">SPA Mode</p>
														<p className="text-xs text-muted-foreground">Route all requests to a single file</p>
													</div>
												</Label>
											</div>
											{routingMode === 'spa' && (
												<div className="ml-7 space-y-2">
													<Label htmlFor="spa-file" className="text-sm">SPA File</Label>
													<Input
														id="spa-file"
														value={spaFile}
														onChange={(e) => setSpaFile(e.target.value)}
														placeholder="index.html"
													/>
												</div>
											)}
											<div className="flex items-center space-x-3 p-3 border rounded-lg">
												<RadioGroupItem value="directory" id="mode-directory" />
												<Label htmlFor="mode-directory" className="flex-1 cursor-pointer">
													<div>
														<p className="font-medium">Directory Listing</p>
														<p className="text-xs text-muted-foreground">Show directory contents on 404</p>
													</div>
												</Label>
											</div>
											<div className="flex items-center space-x-3 p-3 border rounded-lg">
												<RadioGroupItem value="custom404" id="mode-custom404" />
												<Label htmlFor="mode-custom404" className="flex-1 cursor-pointer">
													<div>
														<p className="font-medium">Custom 404 Page</p>
														<p className="text-xs text-muted-foreground">Serve custom error page</p>
													</div>
												</Label>
											</div>
											{routingMode === 'custom404' && (
												<div className="ml-7 space-y-2">
													<Label htmlFor="404-file" className="text-sm">404 File</Label>
													<Input
														id="404-file"
														value={custom404File}
														onChange={(e) => setCustom404File(e.target.value)}
														placeholder="404.html"
													/>
												</div>
											)}
										</RadioGroup>
									</div>

									{/* Index Files */}
									<div className="space-y-3">
										<Label className={`text-sm font-medium ${routingMode === 'spa' ? 'text-muted-foreground' : ''}`}>
											Index Files
											{routingMode === 'spa' && (
												<span className="ml-2 text-xs">(disabled in SPA mode)</span>
											)}
										</Label>
										<p className="text-xs text-muted-foreground">Files to try when serving a directory (in order)</p>
										<div className="space-y-2">
											{indexFiles.map((file, idx) => (
												<div key={idx} className="flex items-center gap-2">
													<Input
														value={file}
														onChange={(e) => {
															const newFiles = [...indexFiles]
															newFiles[idx] = e.target.value
															setIndexFiles(newFiles)
														}}
														placeholder="index.html"
														disabled={routingMode === 'spa'}
													/>
													<Button
														variant="outline"
														size="sm"
														onClick={() => {
															setIndexFiles(indexFiles.filter((_, i) => i !== idx))
														}}
														disabled={routingMode === 'spa'}
														className="w-20"
													>
														Remove
													</Button>
												</div>
											))}
											<div className="flex items-center gap-2">
												<Input
													value={newIndexFile}
													onChange={(e) => setNewIndexFile(e.target.value)}
													placeholder="Add index file..."
													onKeyDown={(e) => {
														if (e.key === 'Enter' && newIndexFile.trim()) {
															setIndexFiles([...indexFiles, newIndexFile.trim()])
															setNewIndexFile('')
														}
													}}
													disabled={routingMode === 'spa'}
												/>
												<Button
													variant="outline"
													size="sm"
													onClick={() => {
														if (newIndexFile.trim()) {
															setIndexFiles([...indexFiles, newIndexFile.trim()])
															setNewIndexFile('')
														}
													}}
													disabled={routingMode === 'spa'}
													className="w-20"
												>
													Add
												</Button>
											</div>
										</div>
									</div>

									{/* Clean URLs */}
									<div className="flex items-center space-x-3 p-3 border rounded-lg">
										<Checkbox
											id="clean-urls"
											checked={cleanUrls}
											onCheckedChange={(checked) => setCleanUrls(!!checked)}
										/>
										<Label htmlFor="clean-urls" className="flex-1 cursor-pointer">
											<div>
												<p className="font-medium">Clean URLs</p>
												<p className="text-xs text-muted-foreground">
													Serve /about as /about.html or /about/index.html
												</p>
											</div>
										</Label>
									</div>

									{/* CORS */}
									<div className="space-y-3">
										<div className="flex items-center space-x-3 p-3 border rounded-lg">
											<Checkbox
												id="cors-enabled"
												checked={corsEnabled}
												onCheckedChange={(checked) => setCorsEnabled(!!checked)}
											/>
											<Label htmlFor="cors-enabled" className="flex-1 cursor-pointer">
												<div>
													<p className="font-medium">Enable CORS</p>
													<p className="text-xs text-muted-foreground">
														Allow cross-origin requests
													</p>
												</div>
											</Label>
										</div>
										{corsEnabled && (
											<div className="ml-7 space-y-2">
												<Label htmlFor="cors-origin" className="text-sm">Allowed Origin</Label>
												<Input
													id="cors-origin"
													value={corsOrigin}
													onChange={(e) => setCorsOrigin(e.target.value)}
													placeholder="*"
												/>
												<p className="text-xs text-muted-foreground">
													Use * for all origins, or specify a domain like https://example.com
												</p>
											</div>
										)}
									</div>
								</TabsContent>
							</Tabs>
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
		</div>
	)
}

function AcceptableUsePage() {
	const navigate = useNavigate()

	return (
		<div className="w-full min-h-screen bg-background flex flex-col">
			{/* Header */}
			<header className="w-full border-b border-border/40 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
				<div className="max-w-6xl w-full mx-auto px-4 h-16 flex items-center justify-between">
					<div className="flex items-center gap-2">
						<img src="/transparent-full-size-ico.png" alt="wisp.place" className="w-8 h-8" />
						<span className="text-xl font-semibold text-foreground">
							wisp.place
						</span>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => navigate('/editor')}
					>
						<ArrowLeft className="w-4 h-4 mr-2" />
						Back to Dashboard
					</Button>
				</div>
			</header>

			{/* Hero Section */}
			<div className="bg-gradient-to-b from-accent/10 to-background border-b border-border/40">
				<div className="container mx-auto px-4 py-16 max-w-4xl text-center">
					<div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/20 mb-6">
						<Shield className="w-8 h-8 text-accent" />
					</div>
					<h1 className="text-4xl md:text-5xl font-bold mb-4">Acceptable Use Policy</h1>
					<div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
						<div className="flex items-center gap-2">
							<span className="font-medium">Effective:</span>
							<span>November 10, 2025</span>
						</div>
						<div className="h-4 w-px bg-border"></div>
						<div className="flex items-center gap-2">
							<span className="font-medium">Last Updated:</span>
							<span>November 10, 2025</span>
						</div>
					</div>
				</div>
			</div>

			{/* Content */}
			<div className="container mx-auto px-4 py-12 max-w-4xl">
				<article className="space-y-12">
					{/* Our Philosophy */}
					<section>
						<h2 className="text-3xl font-bold mb-6 text-foreground">Our Philosophy</h2>
						<div className="space-y-4 text-lg leading-relaxed text-muted-foreground">
							<p>
								wisp.place exists to give you a corner of the internet that's truly yours—a place to create, experiment, and express yourself freely. We believe in the open web and the fundamental importance of free expression. We're not here to police your thoughts, moderate your aesthetics, or judge your taste.
							</p>
							<p>
								That said, we're also real people running real servers in real jurisdictions (the United States and the Netherlands), and there are legal and practical limits to what we can host. This policy aims to be as permissive as possible while keeping the lights on and staying on the right side of the law.
							</p>
						</div>
					</section>

					{/* What You Can Do */}
					<Card className="bg-green-500/5 border-green-500/20 p-8">
						<div className="flex items-start gap-4">
							<div className="flex-shrink-0">
								<CheckCircle className="w-8 h-8 text-green-500" />
							</div>
							<div className="space-y-4">
								<h2 className="text-3xl font-bold text-foreground">What You Can Do</h2>
								<div className="space-y-4 text-lg leading-relaxed text-muted-foreground">
									<p>
										<strong className="text-green-600 dark:text-green-400">Almost anything.</strong> Seriously. Build weird art projects. Write controversial essays. Create spaces that would make corporate platforms nervous. Express unpopular opinions. Make things that are strange, provocative, uncomfortable, or just plain yours.
									</p>
									<p>
										We support creative and personal expression in all its forms, including adult content, political speech, counter-cultural work, and experimental projects.
									</p>
								</div>
							</div>
						</div>
					</Card>

					{/* What You Can't Do */}
					<section>
						<div className="flex items-center gap-3 mb-6">
							<AlertCircle className="w-8 h-8 text-red-500" />
							<h2 className="text-3xl font-bold text-foreground">What You Can't Do</h2>
						</div>

						<div className="space-y-8">
							<Card className="p-6 border-2">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Illegal Content</h3>
								<p className="text-muted-foreground mb-4">
									Don't host content that's illegal in the United States or the Netherlands. This includes but isn't limited to:
								</p>
								<ul className="space-y-3 text-muted-foreground">
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span><strong>Child sexual abuse material (CSAM)</strong> involving real minors in any form</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span><strong>Realistic or AI-generated depictions</strong> of minors in sexual contexts, including photorealistic renders, deepfakes, or AI-generated imagery</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span><strong>Non-consensual intimate imagery</strong> (revenge porn, deepfakes, hidden camera footage, etc.)</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Content depicting or facilitating human trafficking, sexual exploitation, or sexual violence</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Instructions for manufacturing explosives, biological weapons, or other instruments designed for mass harm</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Content that facilitates imminent violence or terrorism</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Stolen financial information, credentials, or personal data used for fraud</span>
									</li>
								</ul>
							</Card>

							<Card className="p-6 border-2">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Intellectual Property Violations</h3>
								<div className="space-y-4 text-muted-foreground">
									<p>
										Don't host content that clearly violates someone else's copyright, trademark, or other intellectual property rights. We're required to respond to valid DMCA takedown notices.
									</p>
									<p>
										We understand that copyright law is complicated and sometimes ridiculous. We're not going to proactively scan your site or nitpick over fair use. But if we receive a legitimate legal complaint, we'll have to act on it.
									</p>
								</div>
							</Card>

							<Card className="p-6 border-2 border-red-500/30 bg-red-500/5">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Hate Content</h3>
								<div className="space-y-4 text-muted-foreground">
									<p>
										You can express controversial ideas. You can be offensive. You can make people uncomfortable. But pure hate—content that exists solely to dehumanize, threaten, or incite violence against people based on race, ethnicity, religion, gender, sexual orientation, disability, or similar characteristics—isn't welcome here.
									</p>
									<p>
										There's a difference between "I have deeply unpopular opinions about X" and "People like X should be eliminated." The former is protected expression. The latter isn't.
									</p>
									<div className="bg-background/50 border-l-4 border-red-500 p-4 rounded">
										<p className="font-medium text-foreground">
											<strong>A note on enforcement:</strong> While we're generally permissive and believe in giving people the benefit of the doubt, hate content is where we draw a hard line. I will be significantly more aggressive in moderating this type of content than anything else on this list. If your site exists primarily to spread hate or recruit people into hateful ideologies, you will be removed swiftly and without extensive appeals. This is non-negotiable.
										</p>
									</div>
								</div>
							</Card>

							<Card className="p-6 border-2">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Adult Content Guidelines</h3>
								<div className="space-y-4 text-muted-foreground">
									<p>
										Adult content is allowed. This includes sexually explicit material, erotica, adult artwork, and NSFW creative expression.
									</p>
									<p className="font-medium">However:</p>
									<ul className="space-y-2">
										<li className="flex items-start gap-3">
											<span className="text-red-500 mt-1">•</span>
											<span>No content involving real minors in any sexual context whatsoever</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-red-500 mt-1">•</span>
											<span>No photorealistic, AI-generated, or otherwise realistic depictions of minors in sexual contexts</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-green-500 mt-1">•</span>
											<span>Clearly stylized drawings and written fiction are permitted, provided they remain obviously non-photographic in nature</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-red-500 mt-1">•</span>
											<span>No non-consensual content (revenge porn, voyeurism, etc.)</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-red-500 mt-1">•</span>
											<span>No content depicting illegal sexual acts (bestiality, necrophilia, etc.)</span>
										</li>
										<li className="flex items-start gap-3">
											<span className="text-yellow-500 mt-1">•</span>
											<span>Adult content should be clearly marked as such if discoverable through public directories or search</span>
										</li>
									</ul>
								</div>
							</Card>

							<Card className="p-6 border-2">
								<h3 className="text-2xl font-semibold mb-4 text-foreground">Malicious Technical Activity</h3>
								<p className="text-muted-foreground mb-4">Don't use your site to:</p>
								<ul className="space-y-2 text-muted-foreground">
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Distribute malware, viruses, or exploits</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Conduct phishing or social engineering attacks</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Launch DDoS attacks or network abuse</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Mine cryptocurrency without explicit user consent</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-red-500 mt-1">•</span>
										<span>Scrape, spam, or abuse other services</span>
									</li>
								</ul>
							</Card>
						</div>
					</section>

					{/* Our Approach to Enforcement */}
					<section>
						<div className="flex items-center gap-3 mb-6">
							<Scale className="w-8 h-8 text-accent" />
							<h2 className="text-3xl font-bold text-foreground">Our Approach to Enforcement</h2>
						</div>
						<div className="space-y-6">
							<div className="space-y-4 text-lg leading-relaxed text-muted-foreground">
								<p>
									<strong>We actively monitor for obvious violations.</strong> Not to censor your creativity or police your opinions, but to catch the clear-cut stuff that threatens the service's existence and makes this a worse place for everyone. We're looking for the blatantly illegal, the obviously harmful—the stuff that would get servers seized and communities destroyed.
								</p>
								<p>
									We're not reading your blog posts looking for wrongthink. We're making sure this platform doesn't become a haven for the kind of content that ruins good things.
								</p>
							</div>

							<Card className="p-6 bg-muted/30">
								<p className="font-semibold mb-3 text-foreground">We take action when:</p>
								<ol className="space-y-2 text-muted-foreground">
									<li className="flex items-start gap-3">
										<span className="font-bold text-accent">1.</span>
										<span>We identify content that clearly violates this policy during routine monitoring</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="font-bold text-accent">2.</span>
										<span>We receive a valid legal complaint (DMCA, court order, etc.)</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="font-bold text-accent">3.</span>
										<span>Someone reports content that violates this policy and we can verify the violation</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="font-bold text-accent">4.</span>
										<span>Your site is causing technical problems for the service or other users</span>
									</li>
								</ol>
							</Card>

							<Card className="p-6 bg-muted/30">
								<p className="font-semibold mb-3 text-foreground">When we do need to take action, we'll try to:</p>
								<ul className="space-y-2 text-muted-foreground">
									<li className="flex items-start gap-3">
										<span className="text-accent">•</span>
										<span>Contact you first when legally and practically possible</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-accent">•</span>
										<span>Be transparent about what's happening and why</span>
									</li>
									<li className="flex items-start gap-3">
										<span className="text-accent">•</span>
										<span>Give you an opportunity to address the issue if appropriate</span>
									</li>
								</ul>
							</Card>

							<p className="text-muted-foreground">
								For serious or repeated violations, we may suspend or terminate your account.
							</p>
						</div>
					</section>

					{/* Regional Compliance */}
					<Card className="p-6 bg-blue-500/5 border-blue-500/20">
						<h2 className="text-2xl font-bold mb-4 text-foreground">Regional Compliance</h2>
						<p className="text-muted-foreground">
							Our servers are located in the United States and the Netherlands. Content hosted on wisp.place must comply with the laws of both jurisdictions. While we aim to provide broad creative freedom, these legal requirements are non-negotiable.
						</p>
					</Card>

					{/* Changes to This Policy */}
					<section>
						<h2 className="text-2xl font-bold mb-4 text-foreground">Changes to This Policy</h2>
						<p className="text-muted-foreground">
							We may update this policy as legal requirements or service realities change. If we make significant changes, we'll notify active users.
						</p>
					</section>

					{/* Questions or Reports */}
					<section>
						<h2 className="text-2xl font-bold mb-4 text-foreground">Questions or Reports</h2>
						<p className="text-muted-foreground">
							If you have questions about this policy or need to report a violation, contact us at{' '}
							<a
								href="mailto:contact@wisp.place"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								contact@wisp.place
							</a>
							.
						</p>
					</section>

					{/* Final Message */}
					<Card className="p-8 bg-accent/10 border-accent/30 border-2">
						<p className="text-lg leading-relaxed text-foreground">
							<strong>Remember:</strong> This policy exists to keep the service running and this community healthy, not to limit your creativity. When in doubt, ask yourself: "Is this likely to get real-world authorities knocking on doors or make this place worse for everyone?" If the answer is yes, it probably doesn't belong here. Everything else? Go wild.
						</p>
					</Card>
				</article>
			</div>

			{/* Footer */}
			<footer className="border-t border-border/40 bg-muted/20 mt-auto">
				<div className="container mx-auto px-4 py-8">
					<div className="text-center text-sm text-muted-foreground">
						<p>
							Built by{' '}
							<a
								href="https://bsky.app/profile/nekomimi.pet"
								target="_blank"
								rel="noopener noreferrer"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								@nekomimi.pet
							</a>
							{' • '}
							Contact:{' '}
							<a
								href="mailto:contact@wisp.place"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								contact@wisp.place
							</a>
							{' • '}
							Legal/DMCA:{' '}
							<a
								href="mailto:legal@wisp.place"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								legal@wisp.place
							</a>
						</p>
						<p className="mt-2">
							<Link
								to="/editor"
								className="text-accent hover:text-accent/80 transition-colors font-medium"
							>
								Back to Dashboard
							</Link>
						</p>
					</div>
				</div>
			</footer>
		</div>
	)
}

function App() {
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/editor" element={<Dashboard />} />
				<Route path="/editor/acceptable-use" element={<AcceptableUsePage />} />
			</Routes>
		</BrowserRouter>
	)
}

const root = createRoot(document.getElementById('elysia')!)
root.render(
	<Layout className="gap-6">
		<App />
	</Layout>
)
