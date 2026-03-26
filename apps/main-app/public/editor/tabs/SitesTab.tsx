import { Badge } from '@public/components/ui/badge'
import { Button } from '@public/components/ui/button'
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import { ChevronDown, ChevronRight, ExternalLink, Globe, Settings as SettingsIcon, Trash2 } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { SiteWithDomains } from '../hooks/useSiteData'
import type { UserInfo } from '../hooks/useUserInfo'

interface SitesTabProps {
	sites: SiteWithDomains[]
	sitesLoading: boolean
	userInfo: UserInfo | null
	onConfigureSite: (site: SiteWithDomains) => void
	onDeleteSite: (site: SiteWithDomains) => void
}

// Helper to generate unique site key
const getSiteKey = (site: SiteWithDomains) => `${site.did}-${site.rkey}`

// Sort domains: custom first, then wisp
const getSortedDomains = (site: SiteWithDomains) => {
	if (!site.domains || site.domains.length === 0) return []
	return [...site.domains].sort((a, b) => {
		if (a.type === 'custom' && b.type === 'wisp') return -1
		if (a.type === 'wisp' && b.type === 'custom') return 1
		return 0
	})
}

// Keyboard shortcut badge component
const Kbd = ({ children }: { children: React.ReactNode }) => (
	<kbd className="px-2 py-1 bg-muted/50 rounded border border-border/50">{children}</kbd>
)

export const SitesTab = memo(function SitesTab({
	sites,
	sitesLoading,
	userInfo,
	onConfigureSite,
	onDeleteSite,
}: SitesTabProps) {
	// State: only one site can be expanded at a time (null = none expanded)
	const [expandedSiteKey, setExpandedSiteKey] = useState<string | null>(null)
	const [focusedIndex, setFocusedIndex] = useState(0)

	// Refs
	const containerRef = useRef<HTMLDivElement>(null)
	const siteRefs = useRef<(HTMLDivElement | null)[]>([])
	const scrollContainerRef = useRef<HTMLDivElement>(null)

	// URL helpers
	const getSiteUrl = useCallback(
		(site: SiteWithDomains) => {
			const sortedDomains = getSortedDomains(site)
			if (sortedDomains.length > 0) {
				return `https://${sortedDomains[0].domain}`
			}
			if (!userInfo) return '#'
			return `https://sites.wisp.place/${userInfo.handle}/${site.rkey}`
		},
		[userInfo],
	)

	const getSiteDomainName = useCallback(
		(site: SiteWithDomains) => {
			const sortedDomains = getSortedDomains(site)
			if (sortedDomains.length > 0) {
				return sortedDomains[0].domain
			}
			if (!userInfo) return `sites.wisp.place/.../${site.rkey}`
			return `sites.wisp.place/${userInfo.handle}/${site.rkey}`
		},
		[userInfo],
	)

	// Toggle expand - auto-closes other sites
	const toggleExpanded = useCallback((siteKey: string) => {
		setExpandedSiteKey((prev) => (prev === siteKey ? null : siteKey))
	}, [])

	// Auto-focus container when sites load
	useEffect(() => {
		if (sites.length > 0 && containerRef.current) {
			const timer = setTimeout(() => containerRef.current?.focus(), 100)
			return () => clearTimeout(timer)
		}
	}, [sites.length])

	// Watch for dialog close and refocus container
	useEffect(() => {
		let wasDialogOpen = document.querySelector('[role="dialog"]') !== null

		const observer = new MutationObserver(() => {
			const isDialogOpen = document.querySelector('[role="dialog"]') !== null

			if (wasDialogOpen && !isDialogOpen) {
				// Dialog just closed, refocus the container
				setTimeout(() => containerRef.current?.focus(), 50)
			}

			wasDialogOpen = isDialogOpen
		})

		observer.observe(document.body, { childList: true })

		return () => observer.disconnect()
	}, [])

	// Scroll focused item into view
	useEffect(() => {
		const element = siteRefs.current[focusedIndex]
		if (element && scrollContainerRef.current) {
			const container = scrollContainerRef.current
			const elementRect = element.getBoundingClientRect()
			const containerRect = container.getBoundingClientRect()

			const isOutOfView = elementRect.bottom > containerRect.bottom - 50 || elementRect.top < containerRect.top + 50

			if (isOutOfView) {
				element.scrollIntoView({ behavior: 'smooth', block: 'center' })
			}
		}
	}, [focusedIndex])

	// Keyboard navigation
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement
			const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
			const isDialogOpen = document.querySelector('[role="dialog"]') !== null
			const hasFocus = containerRef.current?.contains(document.activeElement)

			if (isTyping || isDialogOpen || sites.length === 0 || !hasFocus) return

			const currentSite = sites[focusedIndex]
			const currentKey = currentSite ? getSiteKey(currentSite) : null
			const isExpanded = currentKey === expandedSiteKey

			switch (e.key) {
				case 'ArrowUp':
					e.preventDefault()
					setFocusedIndex((prev) => Math.max(0, prev - 1))
					break
				case 'ArrowDown':
					e.preventDefault()
					setFocusedIndex((prev) => Math.min(sites.length - 1, prev + 1))
					break
				case 'Enter':
				case ' ':
					e.preventDefault()
					if (currentKey) toggleExpanded(currentKey)
					break
				case 'o':
					if (isExpanded && currentSite) {
						e.preventDefault()
						window.open(getSiteUrl(currentSite), '_blank')
					}
					break
				case 'c':
					if (isExpanded && currentSite) {
						e.preventDefault()
						onConfigureSite(currentSite)
					}
					break
				case 'd':
					if (isExpanded && currentSite) {
						e.preventDefault()
						onDeleteSite(currentSite)
					}
					break
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [sites, focusedIndex, expandedSiteKey, toggleExpanded, getSiteUrl, onConfigureSite, onDeleteSite])

	// Loading state
	if (sitesLoading) {
		return (
			<div className="h-full flex flex-col border border-border/30 bg-card/50 font-mono">
				<div className="p-4 pb-3 border-b border-border/30">
					<SkeletonShimmer className="h-4 w-64" />
				</div>
				<div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
					{['a', 'b', 'c', 'd', 'e'].map((id) => (
						<div key={id} className="p-4 border border-border/30">
							<SkeletonShimmer className="h-5 w-full" />
						</div>
					))}
				</div>
			</div>
		)
	}

	// Empty state
	if (sites.length === 0) {
		return (
			<div className="h-full flex flex-col border border-border/30 bg-card/50 font-mono">
				<div className="p-4 pb-3 border-b border-border/30 text-xs text-muted-foreground">
					No keyboard shortcuts available
				</div>
				<div className="flex-1 flex items-center justify-center text-muted-foreground">
					No sites yet. Upload your first site!
				</div>
			</div>
		)
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: keyboard nav focus container
		<div
			ref={containerRef}
			className="h-full flex flex-col border border-border/30 bg-card/50 font-mono outline-none"
			tabIndex={-1}
			onClick={() => containerRef.current?.focus()}
			onKeyDown={() => {}}
		>
			{/* Keyboard hints */}
			<div className="flex items-center gap-4 text-xs text-muted-foreground p-4 pb-3 border-b border-border/30 flex-shrink-0">
				<div className="flex items-center gap-2">
					<Kbd>↑</Kbd>
					<Kbd>↓</Kbd>
					<span>navigate</span>
				</div>
				<span>•</span>
				<div className="flex items-center gap-2">
					<Kbd>Enter</Kbd>
					<span>expand</span>
				</div>
				<span>•</span>
				<span>When expanded:</span>
				<div className="flex items-center gap-2">
					<Kbd>o</Kbd>
					<span>open</span>
				</div>
				<span>•</span>
				<div className="flex items-center gap-2">
					<Kbd>c</Kbd>
					<span>configure</span>
				</div>
				<span>•</span>
				<div className="flex items-center gap-2">
					<Kbd>d</Kbd>
					<span className="text-red-400">delete</span>
				</div>
			</div>

			{/* Sites list */}
			<div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
				{sites.map((site, index) => {
					const siteKey = getSiteKey(site)
					const isExpanded = expandedSiteKey === siteKey
					const isFocused = index === focusedIndex
					const siteName = site.display_name || site.rkey
					const sortedDomains = getSortedDomains(site)

					return (
						<div
							key={siteKey}
							ref={(el) => {
								siteRefs.current[index] = el
							}}
							className={`border transition-colors ${
								isFocused ? 'border-accent bg-accent/10' : 'border-border/30 bg-card hover:bg-muted/10'
							}`}
						>
							{/* Site header */}
							<button
								type="button"
								onClick={() => toggleExpanded(siteKey)}
								className="w-full flex items-center gap-3 p-4 text-left"
							>
								{isExpanded ? (
									<ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
								) : (
									<ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
								)}
								<span className="font-semibold flex-1">{siteName}</span>
								<div className="flex items-center gap-2">
									<span className="text-xs text-muted-foreground">{getSiteDomainName(site)}</span>
									{site.domains && site.domains.length > 1 && (
										<Badge variant="outline" className="text-[10px]">
											+{site.domains.length - 1}
										</Badge>
									)}
								</div>
								<Badge variant="outline" className="text-[10px] text-accent border-accent/50">
									[active]
								</Badge>
							</button>

							{/* Expanded content */}
							{isExpanded && (
								<div className="px-4 pb-4 pl-11 space-y-4 border-l-2 border-accent/50 ml-4">
									{/* Domains */}
									<div>
										<p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
											{sortedDomains.length > 0 ? 'DOMAINS:' : 'DEFAULT URL:'}
										</p>
										{sortedDomains.length > 0 ? (
											<div className="space-y-2">
												{sortedDomains.map((domain) => (
													<div key={domain.domain} className="flex items-center gap-2">
														<a
															href={`https://${domain.domain}`}
															target="_blank"
															rel="noopener noreferrer"
															className="text-sm text-accent hover:text-accent/80 flex items-center gap-2"
														>
															<Globe className="w-3 h-3" />
															{domain.domain}
														</a>
														<Badge variant={domain.type === 'wisp' ? 'secondary' : 'outline'} className="text-[10px]">
															{domain.type}
														</Badge>
														{domain.type === 'custom' && domain.verified !== undefined && (
															<Badge variant={domain.verified ? 'default' : 'secondary'} className="text-[10px]">
																{domain.verified ? '✓ verified' : '⏳ pending'}
															</Badge>
														)}
													</div>
												))}
											</div>
										) : (
											<a
												href={getSiteUrl(site)}
												target="_blank"
												rel="noopener noreferrer"
												className="text-sm text-accent hover:text-accent/80 flex items-center gap-2"
											>
												<Globe className="w-4 h-4" />
												{getSiteDomainName(site)}
											</a>
										)}
									</div>

									{/* Actions */}
									<div>
										<p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">ACTIONS:</p>
										<div className="flex flex-wrap gap-3">
											<Button
												variant="outline"
												size="sm"
												className="font-mono text-xs"
												onClick={() => window.open(getSiteUrl(site), '_blank')}
											>
												<ExternalLink className="w-3 h-3 mr-2" />
												Open
												<kbd className="ml-2 px-1.5 py-0.5 bg-muted/50 rounded text-[10px]">o</kbd>
											</Button>
											<Button
												variant="outline"
												size="sm"
												className="font-mono text-xs"
												onClick={() => onConfigureSite(site)}
											>
												<SettingsIcon className="w-3 h-3 mr-2" />
												Configure
												<kbd className="ml-2 px-1.5 py-0.5 bg-muted/50 rounded text-[10px]">c</kbd>
											</Button>
											<Button
												variant="outline"
												size="sm"
												className="font-mono text-xs text-red-400 hover:text-red-500 hover:border-red-400/50"
												onClick={() => onDeleteSite(site)}
											>
												<Trash2 className="w-3 h-3 mr-2" />
												Delete
												<kbd className="ml-2 px-1.5 py-0.5 bg-muted/50 rounded text-[10px]">d</kbd>
											</Button>
										</div>
									</div>

									{/* View in PDS link */}
									{userInfo && (
										<a
											href={`https://pdsls.dev/at://${userInfo.did}/place.wisp.fs/${site.rkey}`}
											target="_blank"
											rel="noopener noreferrer"
											className="flex items-center gap-2 text-xs text-muted-foreground hover:text-accent transition-colors"
										>
											→ View in PDS
										</a>
									)}
								</div>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
})
