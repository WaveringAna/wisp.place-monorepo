import { Badge } from '@public/components/ui/badge'
import { Button } from '@public/components/ui/button'
import { Checkbox } from '@public/components/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@public/components/ui/dialog'
import { Input } from '@public/components/ui/input'
import { Label } from '@public/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@public/components/ui/radio-group'
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@public/components/ui/tabs'
import Layout from '@public/layouts'
import { Loader2, LogOut, Trash2 } from 'lucide-react'
import { type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { useDomainData } from './hooks/useDomainData'
import { type SiteWithDomains, useSiteData } from './hooks/useSiteData'
import { useUserInfo } from './hooks/useUserInfo'
import { useWebhookData } from './hooks/useWebhookData'
import { CLITab } from './tabs/CLITab'
import { DomainsTab } from './tabs/DomainsTab'
import { SitesTab } from './tabs/SitesTab'
import { UploadTab } from './tabs/UploadTab'
import { WebhooksTab } from './tabs/WebhooksTab'

function Dashboard() {
	// Use custom hooks
	const { userInfo, loading, isAuthenticated, fetchUserInfo } = useUserInfo()
	const { sites, sitesLoading, fetchSites, deleteSite } = useSiteData()
	const {
		webhooks,
		webhooksLoading,
		fetchWebhooks,
		eventLogs,
		eventLogsLoading,
		fetchEventLogs,
		isCreating,
		createWebhook,
		deleteWebhook,
	} = useWebhookData()

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
		checkWispAvailability,
	} = useDomainData()

	// Site configuration modal state (shared across components)
	const [configuringSite, setConfiguringSite] = useState<SiteWithDomains | null>(null)
	const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set())
	const [isSavingConfig, setIsSavingConfig] = useState(false)
	const [isDeletingSite, setIsDeletingSite] = useState(false)
	const [deleteConfirmSite, setDeleteConfirmSite] = useState<SiteWithDomains | null>(null)

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

	// Tab state
	const [activeTab, setActiveTab] = useState('sites')

	// Fetch initial data on mount — empty deps intentional, run once
	// biome-ignore lint/correctness/useExhaustiveDependencies: initial mount fetch
	useEffect(() => {
		fetchUserInfo()
		fetchSites()
		fetchDomains()
		fetchWebhooks()
		fetchEventLogs()
	}, [])

	// Redirect to home if not authenticated
	useEffect(() => {
		if (isAuthenticated === false) {
			window.location.href = '/'
		}
	}, [isAuthenticated])

	// Keyboard navigation for tabs
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Don't handle keyboard shortcuts if:
			// - A modal/dialog is open
			// - User is typing in an input/textarea
			const target = e.target as HTMLElement
			const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
			const isModalOpen = configuringSite !== null || document.querySelector('[role="dialog"]') !== null

			if (isModalOpen || isTyping) {
				return
			}

			// Handle tab navigation with arrow keys (Left/Right only)
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				const tabs = ['sites', 'domains', 'upload', 'webhooks', 'cli']
				const currentIndex = tabs.indexOf(activeTab)

				if (e.key === 'ArrowLeft' && currentIndex > 0) {
					e.preventDefault()
					setActiveTab(tabs[currentIndex - 1])
				} else if (e.key === 'ArrowRight' && currentIndex < tabs.length - 1) {
					e.preventDefault()
					setActiveTab(tabs[currentIndex + 1])
				}
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [activeTab, configuringSite])

	// Handle site configuration modal
	const handleConfigureSite = async (site: SiteWithDomains) => {
		setConfiguringSite(site)

		// Build set of currently mapped domains
		const mappedDomains = new Set<string>()

		if (site.domains) {
			site.domains.forEach((domainInfo) => {
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
				credentials: 'include',
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
			const selectedWispDomainIds = Array.from(selectedDomains).filter((id) => id.startsWith('wisp:'))
			const selectedWispDomains = selectedWispDomainIds.map((id) => id.replace('wisp:', ''))

			// Get currently mapped wisp domains
			const currentlyMappedWispDomains = wispDomains.filter((d) => d.rkey === configuringSite.rkey)

			// Unmap wisp domains that are no longer selected
			for (const domain of currentlyMappedWispDomains) {
				if (!selectedWispDomains.includes(domain.domain)) {
					await mapWispDomain(domain.domain, null)
				}
			}

			// Map newly selected wisp domains
			for (const domainName of selectedWispDomains) {
				const isAlreadyMapped = currentlyMappedWispDomains.some((d) => d.domain === domainName)
				if (!isAlreadyMapped) {
					await mapWispDomain(domainName, configuringSite.rkey)
				}
			}

			// Handle custom domain mappings
			const selectedCustomDomainIds = Array.from(selectedDomains).filter((id) => !id.startsWith('wisp:'))
			const currentlyMappedCustomDomains = customDomains.filter((d) => d.rkey === configuringSite.rkey)

			// Unmap domains that are no longer selected
			for (const domain of currentlyMappedCustomDomains) {
				if (!selectedCustomDomainIds.includes(domain.id)) {
					await mapCustomDomain(domain.id, null)
				}
			}

			// Map newly selected domains
			for (const domainId of selectedCustomDomainIds) {
				const isAlreadyMapped = currentlyMappedCustomDomains.some((d) => d.id === domainId)
				if (!isAlreadyMapped) {
					await mapCustomDomain(domainId, configuringSite.rkey)
				}
			}

			// Save site settings
			const settings: any = {
				cleanUrls,
				indexFiles: indexFiles.filter((f) => f.trim() !== ''),
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
						value: corsOrigin,
					},
				]
			}

			const settingsResponse = await fetch(`/api/site/${configuringSite.rkey}/settings`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify(settings),
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
			alert(`Failed to save configuration: ${err instanceof Error ? err.message : 'Unknown error'}`)
		} finally {
			setIsSavingConfig(false)
		}
	}

	const handleDeleteConfirmSite = async (site: SiteWithDomains) => {
		setDeleteConfirmSite(site)
	}

	const handleDeleteSite = async () => {
		const site = configuringSite || deleteConfirmSite
		if (!site) return

		setIsDeletingSite(true)
		const success = await deleteSite(site.rkey)
		if (success) {
			// Refresh domains in case this site was mapped
			await fetchDomains()
			setConfiguringSite(null)
			setDeleteConfirmSite(null)
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
				credentials: 'include',
			})
			const result = await response.json()
			if (result.success) {
				// Redirect to home page after successful logout
				window.location.href = '/'
			} else {
				alert(`Logout failed: ${result.error || 'Unknown error'}`)
			}
		} catch (err) {
			alert(`Logout failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
		}
	}

	if (loading) {
		return (
			<div className="w-full min-h-screen bg-background font-mono">
				{/* Header Skeleton */}
				<header className="w-full border-b border-border/40 bg-background sticky top-0 z-50">
					<div className="max-w-6xl w-full mx-auto px-6 py-6 flex items-start justify-between">
						<div className="space-y-2">
							<SkeletonShimmer className="h-8 w-48" />
							<SkeletonShimmer className="h-4 w-64" />
						</div>
						<div className="flex items-center gap-3">
							<SkeletonShimmer className="h-4 w-32" />
							<SkeletonShimmer className="h-8 w-8 rounded" />
						</div>
					</div>
				</header>

				<div className="container mx-auto px-6 py-6 max-w-6xl w-full">
					{/* Keyboard shortcuts skeleton */}
					<div className="mb-6">
						<SkeletonShimmer className="h-6 w-96" />
					</div>

					{/* Tabs Skeleton */}
					<div className="space-y-6 w-full">
						<div className="grid w-full grid-cols-5 border-b border-border/50">
							{['a', 'b', 'c', 'd', 'e'].map((id) => (
								<SkeletonShimmer key={id} className="h-10 w-full" />
							))}
						</div>

						{/* Content Skeleton */}
						<div className="space-y-2">
							<SkeletonShimmer className="h-6 w-full mb-4" />
							{['a', 'b', 'c'].map((id) => (
								<div key={id} className="border border-border/30 p-4">
									<SkeletonShimmer className="h-5 w-full" />
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		)
	}

	return (
		<div className="w-full h-screen bg-background flex flex-col font-mono overflow-hidden">
			{/* Header */}
			<header className="w-full border-b border-border/40 bg-background flex-shrink-0">
				<div className="max-w-6xl w-full mx-auto px-6 py-6 flex items-start justify-between">
					<div className="space-y-2">
						<h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
						<p className="text-sm text-muted-foreground">Manage your sites and domains</p>
					</div>
					<div className="flex items-center gap-3">
						<div className="flex items-center gap-2">
							<span className="text-sm text-muted-foreground">{userInfo?.handle || 'Loading...'}</span>
							{userInfo?.isSupporter && (
								<Badge variant="default" className="text-xs">
									Supporter
								</Badge>
							)}
						</div>
						<Button variant="ghost" size="sm" onClick={handleLogout} className="h-8 px-2">
							<LogOut className="w-4 h-4" />
						</Button>
					</div>
				</div>
			</header>

			{/* Main content area - fills remaining space */}
			<div className="flex-1 overflow-hidden flex flex-col">
				<div className="container mx-auto px-6 py-6 max-w-6xl w-full flex flex-col h-full">
					{/* Keyboard shortcuts hint */}
					<div className="mb-4 flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
						<div className="flex items-center gap-2">
							<kbd className="px-2 py-1 bg-muted/50 rounded border border-border/50">←</kbd>
							<kbd className="px-2 py-1 bg-muted/50 rounded border border-border/50">→</kbd>
							<span>switch tabs</span>
						</div>
						<span>•</span>
						<div className="flex items-center gap-2">
							<kbd className="px-2 py-1 bg-muted/50 rounded border border-border/50">↑</kbd>
							<kbd className="px-2 py-1 bg-muted/50 rounded border border-border/50">↓</kbd>
							<span>navigate items</span>
						</div>
					</div>

					<Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col flex-1 overflow-hidden">
						<TabsList className="grid w-full grid-cols-5 bg-card border-b border-border/50 rounded-none h-auto p-0 flex-shrink-0">
							<TabsTrigger
								value="sites"
								className="rounded-none border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none py-3"
							>
								Sites
							</TabsTrigger>
							<TabsTrigger
								value="domains"
								className="rounded-none border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none py-3"
							>
								Domains
							</TabsTrigger>
							<TabsTrigger
								value="upload"
								className="rounded-none border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none py-3"
							>
								Upload
							</TabsTrigger>
							<TabsTrigger
								value="webhooks"
								className="rounded-none border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none py-3"
							>
								Webhooks
							</TabsTrigger>
							<TabsTrigger
								value="cli"
								className="rounded-none border-b-2 border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50 data-[state=active]:border-accent data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none py-3"
							>
								Cli
							</TabsTrigger>
						</TabsList>

						{/* Sites Tab */}
						<TabsContent value="sites" className="flex-1 m-0 mt-4 overflow-hidden data-[state=inactive]:hidden">
							<SitesTab
								sites={sites}
								sitesLoading={sitesLoading}
								userInfo={userInfo}
								onConfigureSite={handleConfigureSite}
								onDeleteSite={handleDeleteConfirmSite}
							/>
						</TabsContent>

						{/* Domains Tab */}
						<TabsContent value="domains" className="flex-1 m-0 mt-4 overflow-hidden data-[state=inactive]:hidden">
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
						<TabsContent value="upload" className="flex-1 m-0 mt-4 overflow-hidden data-[state=inactive]:hidden">
							<UploadTab sites={sites} sitesLoading={sitesLoading} onUploadComplete={handleUploadComplete} />
						</TabsContent>

						{/* Webhooks Tab */}
						<TabsContent value="webhooks" className="flex-1 m-0 mt-4 overflow-hidden data-[state=inactive]:hidden">
							<WebhooksTab
								webhooks={webhooks}
								webhooksLoading={webhooksLoading}
								eventLogs={eventLogs}
								eventLogsLoading={eventLogsLoading}
								isCreating={isCreating}
								userDid={userInfo?.did}
								onCreateWebhook={createWebhook}
								onDeleteWebhook={deleteWebhook}
								onRefreshEvents={fetchEventLogs}
							/>
						</TabsContent>

						{/* CLI Tab */}
						<TabsContent value="cli" className="flex-1 m-0 mt-4 overflow-hidden data-[state=inactive]:hidden">
							<CLITab />
						</TabsContent>
					</Tabs>
				</div>
			</div>

			{/* Footer - always visible */}
			<footer className="border-t border-border/30 font-mono flex-shrink-0 bg-background">
				<div className="container mx-auto px-6 py-4 max-w-6xl">
					<div className="flex items-center justify-between text-xs text-muted-foreground">
						<div className="flex items-center gap-6">
							<span>
								Built by{' '}
								<a
									href="https://bsky.app/profile/null.namespaces.me"
									target="_blank"
									rel="noopener noreferrer"
									className="text-accent hover:text-accent/80 transition-colors"
								>
									@null.namespaces.me
								</a>
							</span>
							<span>
								Contact:{' '}
								<a href="mailto:contact@wisp.place" className="text-accent hover:text-accent/80 transition-colors">
									contact@wisp.place
								</a>
							</span>
							<span>
								Legal:{' '}
								<a href="mailto:legal@wisp.place" className="text-accent hover:text-accent/80 transition-colors">
									legal@wisp.place
								</a>
							</span>
						</div>
						<div className="flex items-center gap-4">
							<a href="/acceptable-use" className="text-accent hover:text-accent/80 transition-colors">
								Acceptable Use Policy
							</a>
							<a href="/privacy" className="text-accent hover:text-accent/80 transition-colors">
								Privacy Policy
							</a>
						</div>
					</div>
				</div>
			</footer>

			{/* Site Configuration Modal */}
			<Dialog open={configuringSite !== null} onOpenChange={(open: boolean) => !open && setConfiguringSite(null)}>
				<DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Configure Site</DialogTitle>
						<DialogDescription>Configure domains and settings for this site.</DialogDescription>
					</DialogHeader>
					{configuringSite && (
						<div className="space-y-4 py-4">
							<div className="p-3 bg-muted/30 rounded-lg">
								<p className="text-sm font-medium mb-1">Site:</p>
								<p className="font-mono text-sm">{configuringSite.display_name || configuringSite.rkey}</p>
							</div>

							<Tabs defaultValue="domains" className="w-full">
								<TabsList className="grid w-full grid-cols-2 bg-card border-b border-border/50 rounded-none h-auto p-0 flex-shrink-0">
									<TabsTrigger
										value="domains"
										className="text-muted-foreground hover:text-foreground hover:bg-muted/50 data-[state=active]:bg-transparent data-[state=active]:text-foreground"
									>
										Domains
									</TabsTrigger>
									<TabsTrigger
										value="settings"
										className="text-muted-foreground hover:text-foreground hover:bg-muted/50 data-[state=active]:bg-transparent data-[state=active]:text-foreground"
									>
										Settings
									</TabsTrigger>
								</TabsList>

								{/* Domains Tab */}
								<TabsContent value="domains" className="space-y-3 mt-4">
									<p className="text-sm font-medium">Available Domains:</p>

									{wispDomains.map((wispDomain) => {
										const domainId = `wisp:${wispDomain.domain}`
										return (
											<div
												key={domainId}
												className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/30"
											>
												<Checkbox
													id={domainId}
													checked={selectedDomains.has(domainId)}
													onCheckedChange={(checked: boolean | 'indeterminate') => {
														const newSelected = new Set(selectedDomains)
														if (checked) {
															newSelected.add(domainId)
														} else {
															newSelected.delete(domainId)
														}
														setSelectedDomains(newSelected)
													}}
												/>
												<Label htmlFor={domainId} className="flex-1 cursor-pointer">
													<div className="flex items-center justify-between">
														<span className="font-mono text-sm">{wispDomain.domain}</span>
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
													onCheckedChange={(checked: boolean | 'indeterminate') => {
														const newSelected = new Set(selectedDomains)
														if (checked) {
															newSelected.add(domain.id)
														} else {
															newSelected.delete(domain.id)
														}
														setSelectedDomains(newSelected)
													}}
												/>
												<Label htmlFor={domain.id} className="flex-1 cursor-pointer">
													<div className="flex items-center justify-between">
														<span className="font-mono text-sm">{domain.domain}</span>
														<Badge variant="outline" className="text-xs ml-2">
															Custom
														</Badge>
													</div>
												</Label>
											</div>
										))}

									{customDomains.filter((d) => d.verified).length === 0 && wispDomains.length === 0 && (
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
										<RadioGroup
											value={routingMode}
											onValueChange={(value: string) => setRoutingMode(value as RoutingMode)}
										>
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
													<Label htmlFor="spa-file" className="text-sm">
														SPA File
													</Label>
													<Input
														id="spa-file"
														value={spaFile}
														onChange={(e: ChangeEvent<HTMLInputElement>) => setSpaFile(e.target.value)}
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
													<Label htmlFor="404-file" className="text-sm">
														404 File
													</Label>
													<Input
														id="404-file"
														value={custom404File}
														onChange={(e: ChangeEvent<HTMLInputElement>) => setCustom404File(e.target.value)}
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
											{routingMode === 'spa' && <span className="ml-2 text-xs">(disabled in SPA mode)</span>}
										</Label>
										<p className="text-xs text-muted-foreground">Files to try when serving a directory (in order)</p>
										<div className="space-y-2">
											{indexFiles.map((file, idx) => (
												<div key={file || idx} className="flex items-center gap-2">
													<Input
														value={file}
														onChange={(e: ChangeEvent<HTMLInputElement>) => {
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
													onChange={(e: ChangeEvent<HTMLInputElement>) => setNewIndexFile(e.target.value)}
													placeholder="Add index file..."
													onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
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
											onCheckedChange={(checked: boolean | 'indeterminate') => setCleanUrls(!!checked)}
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
												onCheckedChange={(checked: boolean | 'indeterminate') => setCorsEnabled(!!checked)}
											/>
											<Label htmlFor="cors-enabled" className="flex-1 cursor-pointer">
												<div>
													<p className="font-medium">Enable CORS</p>
													<p className="text-xs text-muted-foreground">Allow cross-origin requests</p>
												</div>
											</Label>
										</div>
										{corsEnabled && (
											<div className="ml-7 space-y-2">
												<Label htmlFor="cors-origin" className="text-sm">
													Allowed Origin
												</Label>
												<Input
													id="cors-origin"
													value={corsOrigin}
													onChange={(e: ChangeEvent<HTMLInputElement>) => setCorsOrigin(e.target.value)}
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

			{/* Delete Site Confirmation Modal */}
			<Dialog open={deleteConfirmSite !== null} onOpenChange={(open: boolean) => !open && setDeleteConfirmSite(null)}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Delete Site</DialogTitle>
						<DialogDescription>
							Are you sure you want to delete "{deleteConfirmSite?.display_name || deleteConfirmSite?.rkey}"? This
							action cannot be undone.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="flex flex-col sm:flex-row gap-2 sm:justify-end">
						<Button
							variant="outline"
							onClick={() => setDeleteConfirmSite(null)}
							disabled={isDeletingSite}
							className="w-full sm:w-auto"
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							onClick={handleDeleteSite}
							disabled={isDeletingSite}
							className="w-full sm:w-auto"
						>
							{isDeletingSite ? (
								<>
									<Loader2 className="w-4 h-4 mr-2 animate-spin" />
									Deleting...
								</>
							) : (
								'Delete'
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

function AcceptableUsePage() {
	// Redirect to public acceptable use page
	useEffect(() => {
		window.location.href = '/acceptable-use'
	}, [])

	// Show loading state while redirecting
	return (
		<div className="w-full min-h-screen bg-background flex items-center justify-center">
			<Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
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
	</Layout>,
)
