import { Badge } from '@public/components/ui/badge'
import { Button } from '@public/components/ui/button'
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import {
	Check,
	ChevronDown,
	ChevronRight,
	Copy,
	ExternalLink,
	Globe,
	Link2,
	Lock,
	Settings as SettingsIcon,
	Trash2,
} from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { usePrivateShares } from '../hooks/usePrivateShares'
import type { PrivateShare, SiteWithDomains } from '../hooks/useSiteData'
import type { UserInfo } from '../hooks/useUserInfo'

interface SitesTabProps {
	sites: SiteWithDomains[]
	sitesLoading: boolean
	userInfo: UserInfo | null
	onConfigureSite: (site: SiteWithDomains) => void
	onDeleteSite: (site: SiteWithDomains) => void
}

// Helper to generate unique site key. Private sites have no DID, so they are namespaced
// separately to avoid colliding with a public site that shares an rkey.
const getSiteKey = (site: SiteWithDomains) => (site.isPrivate ? `private-${site.siteId}` : `${site.did}-${site.rkey}`)

// Relative expiry label for private sites.
const formatExpiry = (expiresAt: string | null | undefined, expired: boolean | undefined): string => {
	if (expired) return 'expired'
	if (!expiresAt) return 'never expires'
	const mins = Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000)
	if (mins <= 0) return 'expired'
	if (mins < 60) return `expires in ${mins}m`
	if (mins < 60 * 24) return `expires in ${Math.round(mins / 60)}h`
	return `expires in ${Math.round(mins / (60 * 24))}d`
}

const formatBytes = (bytes: number | undefined): string => {
	if (!bytes) return '0 B'
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

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

interface PrivateSharePanelProps {
	siteId: string
	shares: PrivateShare[]
	loading: boolean
	/**
	 * Present only immediately after creating a link. The server stores a hash, so this URL
	 * cannot be recovered once the panel closes.
	 */
	justCreatedUrl: string | null
	copied: boolean
	onLoad: (siteId: string) => void
	onCreate: (
		siteId: string,
		options?: { label?: string; expiryMinutes?: number; audienceDid?: string },
	) => Promise<string | null>
	onRevoke: (siteId: string, shareId: string) => Promise<boolean>
	onCopy: (text: string) => void
}

/** Share-link management for one private site. */
const PrivateSharePanel = memo(function PrivateSharePanel({
	siteId,
	shares,
	loading,
	justCreatedUrl,
	copied,
	onLoad,
	onCreate,
	onRevoke,
	onCopy,
}: PrivateSharePanelProps) {
	const [label, setLabel] = useState('')
	const [creating, setCreating] = useState(false)
	const [handle, setHandle] = useState('')
	/**
	 * Resolution of the typed handle.
	 *
	 * A scoped link is only as good as the DID behind it, so the handle is resolved before
	 * the link is created and the resolved DID is what gets sent. Typing a handle that does
	 * not resolve disables creation rather than silently making a bearer link.
	 */
	const [resolved, setResolved] = useState<{ handle: string; did: string } | null>(null)
	const [resolving, setResolving] = useState(false)

	// Debounced so a lookup does not fire on every keystroke, and stale responses are
	// discarded rather than overwriting a newer one.
	useEffect(() => {
		const query = handle.trim().replace(/^@/, '')
		if (!query) {
			setResolved(null)
			setResolving(false)
			return
		}
		let cancelled = false
		setResolving(true)
		const timer = setTimeout(async () => {
			try {
				const res = await fetch(`/api/user/private-sites/resolve-handle?handle=${encodeURIComponent(query)}`)
				const data = await res.json()
				if (cancelled) return
				setResolved(data.found ? { handle: data.handle, did: data.did } : null)
			} catch {
				if (!cancelled) setResolved(null)
			} finally {
				if (!cancelled) setResolving(false)
			}
		}, 350)
		return () => {
			cancelled = true
			clearTimeout(timer)
		}
	}, [handle])

	// Shares are fetched lazily, only when a private site is actually expanded.
	useEffect(() => {
		if (siteId) onLoad(siteId)
	}, [siteId, onLoad])

	const scopeReady = handle.trim().length === 0 || resolved !== null

	const handleCreate = useCallback(async () => {
		setCreating(true)
		await onCreate(siteId, {
			...(label.trim() ? { label: label.trim() } : {}),
			...(resolved ? { audienceDid: resolved.did } : {}),
		})
		setLabel('')
		setHandle('')
		setResolved(null)
		setCreating(false)
	}, [siteId, label, resolved, onCreate])

	return (
		<div>
			<p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">SHARE LINKS:</p>

			{/* One-time reveal. This is the only moment the credential is available. */}
			{justCreatedUrl && (
				<div className="mb-3 p-3 border border-violet-400/50 bg-violet-400/10 space-y-2">
					<p className="text-xs text-violet-200">Copy this now — it is shown once and cannot be retrieved later.</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 text-xs break-all bg-background/50 px-2 py-1.5 rounded">{justCreatedUrl}</code>
						<Button
							variant="outline"
							size="sm"
							className="font-mono text-xs flex-shrink-0"
							onClick={() => onCopy(justCreatedUrl)}
						>
							{copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
						</Button>
					</div>
				</div>
			)}

			<div className="space-y-1.5 mb-3">
				<div className="flex items-center gap-2">
					<input
						type="text"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="label (optional)"
						className="flex-1 text-xs bg-background/50 border border-border/50 px-2 py-1.5 font-mono outline-none focus:border-accent"
					/>
					<Button
						variant="outline"
						size="sm"
						className="font-mono text-xs"
						disabled={creating || !scopeReady}
						onClick={handleCreate}
					>
						<Link2 className="w-3 h-3 mr-2" />
						{creating ? 'Creating...' : 'New link'}
					</Button>
				</div>

				{/* Leaving this empty makes a bearer link, which is what someone without an
				    atproto account needs. Filling it scopes the link to one person. */}
				<input
					type="text"
					value={handle}
					onChange={(e) => setHandle(e.target.value)}
					placeholder="share with an account (optional) — e.g. alice.bsky.social"
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
					className="w-full text-xs bg-background/50 border border-border/50 px-2 py-1.5 font-mono outline-none focus:border-accent"
				/>

				{handle.trim().length > 0 && (
					<p className="text-[10px] font-mono">
						{resolving ? (
							<span className="text-muted-foreground">resolving…</span>
						) : resolved ? (
							<span className="text-green-400">
								<Check className="w-3 h-3 inline mr-1" />
								{resolved.handle} · <span className="text-muted-foreground">{resolved.did}</span>
							</span>
						) : (
							<span className="text-amber-400">no account found for that handle</span>
						)}
					</p>
				)}

				<p className="text-[10px] text-muted-foreground">
					{resolved
						? 'only this account can open the link; they will be asked to sign in'
						: 'leave blank for a link anyone can open, including people without an atproto account'}
				</p>
			</div>

			{loading ? (
				<SkeletonShimmer className="h-8 w-full" />
			) : shares.length === 0 ? (
				<p className="text-xs text-muted-foreground">No share links yet.</p>
			) : (
				<div className="space-y-1.5">
					{shares.map((share) => (
						<div key={share.shareId} className="flex items-center gap-2 text-xs">
							<Badge
								variant="outline"
								className={`text-[10px] ${
									share.status === 'active'
										? 'text-green-400 border-green-400/50'
										: share.status === 'revoked'
											? 'text-red-400 border-red-400/50'
											: 'text-amber-400 border-amber-400/50'
								}`}
							>
								{share.status}
							</Badge>
							{/* Only the non-secret prefix is ever available here. */}
							<code className="text-muted-foreground">{share.tokenPrefix}...</code>
							{share.label && <span className="text-muted-foreground truncate">{share.label}</span>}
							{/* A scoped link needs its audience visible, or there is no way to tell
							    two links apart once the URL itself is gone. */}
							{share.audienceDid && (
								<Badge variant="outline" className="text-[10px] text-violet-300 border-violet-400/50 flex-shrink-0">
									<Lock className="w-2.5 h-2.5 mr-1" />
									{share.audienceDid}
								</Badge>
							)}
							<span className="text-muted-foreground/60 ml-auto">
								{share.expiresAt ? formatExpiry(share.expiresAt, false) : 'never expires'}
							</span>
							{share.status === 'active' && (
								<Button
									variant="ghost"
									size="sm"
									className="h-6 px-2 text-[10px] text-red-400 hover:text-red-500"
									onClick={() => onRevoke(siteId, share.shareId)}
								>
									revoke
								</Button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	)
})

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
	const [copied, setCopied] = useState(false)

	const {
		shares,
		loading: sharesLoading,
		justCreated,
		fetchShares,
		createShare,
		revokeShare,
		clearJustCreated,
	} = usePrivateShares()

	// Refs
	const containerRef = useRef<HTMLDivElement>(null)
	const siteRefs = useRef<(HTMLDivElement | null)[]>([])
	const scrollContainerRef = useRef<HTMLDivElement>(null)

	// URL helpers
	const getSiteUrl = useCallback(
		(site: SiteWithDomains) => {
			// Private sites are only ever reachable on the private host.
			if (site.isPrivate) return site.privateUrl ?? '#'
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
			if (site.isPrivate) return formatExpiry(site.expiresAt, site.expired)
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
	const toggleExpanded = useCallback(
		(siteKey: string) => {
			// Collapsing discards the one-time share URL held in memory.
			clearJustCreated()
			setCopied(false)
			setExpandedSiteKey((prev) => (prev === siteKey ? null : siteKey))
		},
		[clearJustCreated],
	)

	/**
	 * Open a private site as its owner.
	 *
	 * The account session is host-only to this origin, so the private host cannot see it.
	 * Mint a single-use handoff token and follow the URL that exchanges it for a
	 * site-scoped session.
	 */
	const openPrivateSite = useCallback(async (siteId: string) => {
		try {
			const response = await fetch(`/api/user/private-sites/${siteId}/open`, { method: 'POST' })
			const data = await response.json()
			if (!data.success) throw new Error(data.error || 'Failed to open private site')
			window.open(data.url, '_blank', 'noopener')
		} catch (err) {
			console.error('Open private site error:', err)
			alert(`Failed to open private site: ${err instanceof Error ? err.message : 'Unknown error'}`)
		}
	}, [])

	const copyToClipboard = useCallback(async (text: string) => {
		try {
			await navigator.clipboard.writeText(text)
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		} catch (err) {
			console.error('Failed to copy:', err)
		}
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
						if (currentSite.isPrivate) {
							void openPrivateSite(currentSite.siteId ?? currentSite.rkey)
						} else {
							window.open(getSiteUrl(currentSite), '_blank')
						}
					}
					break
				case 'c':
					// Configure opens a place.wisp.settings workflow, which private sites do
					// not have. The button is hidden for them, so the shortcut is too.
					if (isExpanded && currentSite && !currentSite.isPrivate) {
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
	}, [sites, focusedIndex, expandedSiteKey, toggleExpanded, getSiteUrl, onConfigureSite, onDeleteSite, openPrivateSite])

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
			onClick={(e) => {
				// Clicking bare chrome returns focus to the keyboard-nav container, but a click
				// that landed on a real control must be left alone — stealing focus back here
				// is what made the share-link inputs impossible to type into.
				const t = e.target as HTMLElement
				if (!t.closest('input, textarea, button, select, a, label')) {
					containerRef.current?.focus()
				}
			}}
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
								<span className="font-semibold flex-1 flex items-center gap-2">
									{siteName}
									{site.isPrivate && (
										<Badge
											variant="outline"
											className="text-[10px] text-violet-300 border-violet-400/50 bg-violet-400/10 gap-1"
										>
											<Lock className="w-2.5 h-2.5" />
											private
										</Badge>
									)}
								</span>
								<div className="flex items-center gap-2">
									<span className="text-xs text-muted-foreground">{getSiteDomainName(site)}</span>
									{site.isPrivate && (site.shareCount ?? 0) > 0 && (
										<Badge variant="secondary" className="text-[10px] gap-1">
											<Link2 className="w-2.5 h-2.5" />
											{site.shareCount}
										</Badge>
									)}
									{!site.isPrivate && site.domains && site.domains.length > 1 && (
										<Badge variant="outline" className="text-[10px]">
											+{site.domains.length - 1}
										</Badge>
									)}
								</div>
								<Badge
									variant="outline"
									className={`text-[10px] ${
										site.expired ? 'text-amber-400 border-amber-400/50' : 'text-accent border-accent/50'
									}`}
								>
									{site.expired ? '[expired]' : '[active]'}
								</Badge>
							</button>

							{/* Expanded content */}
							{isExpanded && (
								<div className="px-4 pb-4 pl-11 space-y-4 border-l-2 border-accent/50 ml-4">
									{site.isPrivate ? (
										<>
											{/* Private URL + stats */}
											<div>
												<p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">PRIVATE URL:</p>
												<button
													type="button"
													onClick={() => void openPrivateSite(site.siteId ?? site.rkey)}
													className="text-sm text-accent hover:text-accent/80 flex items-center gap-2 text-left"
												>
													<Lock className="w-3 h-3" />
													{site.privateUrl}
												</button>
												<p className="text-xs text-muted-foreground mt-2">
													{site.fileCount} files · {formatBytes(site.totalBytes)} ·{' '}
													{formatExpiry(site.expiresAt, site.expired)}
												</p>
												<p className="text-xs text-muted-foreground mt-1">
													Only you can open this while signed in. Not published to your PDS.
												</p>
											</div>

											{/* Share links */}
											<PrivateSharePanel
												siteId={site.siteId ?? ''}
												shares={shares[site.siteId ?? ''] ?? []}
												loading={Boolean(sharesLoading[site.siteId ?? ''])}
												justCreatedUrl={justCreated && justCreated.siteId === site.siteId ? justCreated.url : null}
												copied={copied}
												onLoad={fetchShares}
												onCreate={createShare}
												onRevoke={revokeShare}
												onCopy={copyToClipboard}
											/>
										</>
									) : (
										<>
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
																<Badge
																	variant={domain.type === 'wisp' ? 'secondary' : 'outline'}
																	className="text-[10px]"
																>
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
										</>
									)}

									{/* Actions */}
									<div>
										<p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">ACTIONS:</p>
										<div className="flex flex-wrap gap-3">
											<Button
												variant="outline"
												size="sm"
												className="font-mono text-xs"
												onClick={() =>
													site.isPrivate
														? void openPrivateSite(site.siteId ?? site.rkey)
														: window.open(getSiteUrl(site), '_blank')
												}
											>
												<ExternalLink className="w-3 h-3 mr-2" />
												Open
												<kbd className="ml-2 px-1.5 py-0.5 bg-muted/50 rounded text-[10px]">o</kbd>
											</Button>
											{/* Configure writes a place.wisp.settings record, which private sites do not have. */}
											{!site.isPrivate && (
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
											)}
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

									{/* View in PDS link. Private sites are never written to the PDS. */}
									{userInfo && !site.isPrivate && (
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
