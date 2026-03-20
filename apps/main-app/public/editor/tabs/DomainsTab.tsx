import { Badge } from '@public/components/ui/badge'
import { Button } from '@public/components/ui/button'
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
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import { AlertCircle, CheckCircle2, Loader2, Trash2, XCircle } from 'lucide-react'
import { type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'
import type { CustomDomain, WispDomain } from '../hooks/useDomainData'
import type { UserInfo } from '../hooks/useUserInfo'

// Hosting node IP addresses for A record fallback
const HOSTING_NODES = [
	{ region: 'US East (Virginia)', ip: '129.213.110.75' },
	{ region: 'US West (California)', ip: '152.44.44.138' },
	{ region: 'Europe (Netherlands)', ip: '152.53.121.97' },
	{ region: 'Asia (Singapore)', ip: '213.163.207.16' },
] as const

interface DomainsTabProps {
	wispDomains: WispDomain[]
	customDomains: CustomDomain[]
	domainsLoading: boolean
	verificationStatus: { [id: string]: 'idle' | 'verifying' | 'success' | 'error' }
	userInfo: UserInfo | null
	onAddCustomDomain: (domain: string) => Promise<{ success: boolean; id?: string }>
	onVerifyDomain: (id: string) => Promise<{ warning?: string }>
	onDeleteCustomDomain: (id: string) => Promise<boolean>
	onDeleteWispDomain: (domain: string) => Promise<boolean>
	onClaimWispDomain: (handle: string) => Promise<{ success: boolean; error?: string }>
	onCheckWispAvailability: (handle: string) => Promise<{ available: boolean | null }>
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
	<kbd className="px-2 py-1 bg-muted/50 rounded border border-border/50">{children}</kbd>
)

export function DomainsTab({
	wispDomains,
	customDomains,
	domainsLoading,
	verificationStatus,
	userInfo,
	onAddCustomDomain,
	onVerifyDomain,
	onDeleteCustomDomain,
	onDeleteWispDomain,
	onClaimWispDomain,
	onCheckWispAvailability,
}: DomainsTabProps) {
	// Wisp domain claim state
	const [wispHandle, setWispHandle] = useState('')
	const [isClaimingWisp, setIsClaimingWisp] = useState(false)
	const [wispAvailability, setWispAvailability] = useState<{
		available: boolean | null
		checking: boolean
	}>({ available: null, checking: false })

	// Verification warning state
	const [verificationWarning, setVerificationWarning] = useState<{ id: string; message: string } | null>(null)

	// Custom domain modal state
	const [addDomainModalOpen, setAddDomainModalOpen] = useState(false)
	const [customDomain, setCustomDomain] = useState('')
	const [isAddingDomain, setIsAddingDomain] = useState(false)
	const [viewDomainDNS, setViewDomainDNS] = useState<string | null>(null)
	const [copiedField, setCopiedField] = useState<string | null>(null)

	// Keyboard nav state
	const [focusedIndex, setFocusedIndex] = useState(0)
	const containerRef = useRef<HTMLDivElement>(null)
	const itemRefs = useRef<(HTMLDivElement | null)[]>([])
	const scrollContainerRef = useRef<HTMLDivElement>(null)

	const totalDomains = wispDomains.length + customDomains.length

	// Clamp focusedIndex when domains change
	useEffect(() => {
		if (totalDomains > 0 && focusedIndex >= totalDomains) {
			setFocusedIndex(totalDomains - 1)
		}
	}, [totalDomains, focusedIndex])

	// Auto-focus when domains first load
	useEffect(() => {
		if (!domainsLoading && totalDomains > 0 && containerRef.current) {
			const timer = setTimeout(() => containerRef.current?.focus(), 100)
			return () => clearTimeout(timer)
		}
	}, [domainsLoading, totalDomains])

	// Refocus container when a dialog closes
	useEffect(() => {
		let wasOpen = document.querySelector('[role="dialog"]') !== null
		const observer = new MutationObserver(() => {
			const isOpen = document.querySelector('[role="dialog"]') !== null
			if (wasOpen && !isOpen) setTimeout(() => containerRef.current?.focus(), 50)
			wasOpen = isOpen
		})
		observer.observe(document.body, { childList: true, subtree: true })
		return () => observer.disconnect()
	}, [])

	// Scroll focused item into view
	useEffect(() => {
		const element = itemRefs.current[focusedIndex]
		if (element && scrollContainerRef.current) {
			const container = scrollContainerRef.current
			const elementRect = element.getBoundingClientRect()
			const containerRect = container.getBoundingClientRect()
			const isOutOfView = elementRect.bottom > containerRect.bottom - 50 || elementRect.top < containerRect.top + 50
			if (isOutOfView) element.scrollIntoView({ behavior: 'smooth', block: 'center' })
		}
	}, [focusedIndex])

	// Keyboard navigation
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement
			const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
			const isDialogOpen = document.querySelector('[role="dialog"]') !== null
			const hasFocus = containerRef.current?.contains(document.activeElement)

			if (isTyping || isDialogOpen || !hasFocus || totalDomains === 0) return

			const isWisp = focusedIndex < wispDomains.length
			const domain = isWisp ? wispDomains[focusedIndex] : customDomains[focusedIndex - wispDomains.length]

			switch (e.key) {
				case 'ArrowUp':
					e.preventDefault()
					setFocusedIndex((prev) => Math.max(0, prev - 1))
					break
				case 'ArrowDown':
					e.preventDefault()
					setFocusedIndex((prev) => Math.min(totalDomains - 1, prev + 1))
					break
				case 'd':
					e.preventDefault()
					if (isWisp) {
						onDeleteWispDomain((domain as WispDomain).domain)
					} else {
						onDeleteCustomDomain((domain as CustomDomain).id)
					}
					break
				case 'v':
					if (!isWisp) {
						const cd = domain as CustomDomain
						if (!cd.verified && verificationStatus[cd.id] !== 'verifying') {
							e.preventDefault()
							onVerifyDomain(cd.id).then((result) => {
								if (result.warning) {
									setVerificationWarning({ id: cd.id, message: result.warning })
								}
							})
						}
					}
					break
				case 'Enter':
					if (!isWisp) {
						e.preventDefault()
						setViewDomainDNS((domain as CustomDomain).id)
					}
					break
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [
		totalDomains,
		focusedIndex,
		wispDomains,
		customDomains,
		verificationStatus,
		onDeleteWispDomain,
		onDeleteCustomDomain,
		onVerifyDomain,
	])

	const copyToClipboard = async (value: string, label: string) => {
		try {
			await navigator.clipboard.writeText(value)
			setCopiedField(label)
			window.setTimeout(() => {
				setCopiedField((current) => (current === label ? null : current))
			}, 1400)
		} catch {
			setCopiedField(null)
		}
	}

	const checkWispAvailability = async (handle: string) => {
		const trimmed = handle.trim().toLowerCase()
		if (!trimmed) {
			setWispAvailability({ available: null, checking: false })
			return
		}
		setWispAvailability({ available: null, checking: true })
		const result = await onCheckWispAvailability(trimmed)
		setWispAvailability({ available: result.available, checking: false })
	}

	const handleClaimWispDomain = async () => {
		const trimmed = wispHandle.trim().toLowerCase()
		if (!trimmed) {
			alert('Please enter a handle')
			return
		}
		setIsClaimingWisp(true)
		const result = await onClaimWispDomain(trimmed)
		if (result.success) {
			setWispHandle('')
			setWispAvailability({ available: null, checking: false })
		}
		setIsClaimingWisp(false)
	}

	const handleAddCustomDomain = async () => {
		if (!customDomain) {
			alert('Please enter a domain')
			return
		}
		setIsAddingDomain(true)
		const result = await onAddCustomDomain(customDomain)
		setIsAddingDomain(false)
		if (result.success) {
			setCustomDomain('')
			setAddDomainModalOpen(false)
			if (result.id) setViewDomainDNS(result.id)
		}
	}

	const canClaimMore = wispDomains.length < 3 || !!userInfo?.isSupporter

	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard nav focus container */}
			<div
				ref={containerRef}
				className="h-full flex flex-col border border-border/30 bg-card/50 font-mono outline-none"
				tabIndex={-1}
				onKeyDown={() => {}}
				onClick={(e) => {
					const t = e.target as HTMLElement
					if (!t.closest('input, textarea, button, select, a, label')) {
						containerRef.current?.focus()
					}
				}}
			>
				{/* Keyboard hints */}
				<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground p-4 pb-3 border-b border-border/30 flex-shrink-0">
					{totalDomains > 0 ? (
						<>
							<div className="flex items-center gap-2">
								<Kbd>↑</Kbd>
								<Kbd>↓</Kbd>
								<span>navigate</span>
							</div>
							<span>•</span>
							<div className="flex items-center gap-2">
								<Kbd>d</Kbd>
								<span className="text-red-400">delete</span>
							</div>
							<span>•</span>
							<div className="flex items-center gap-2">
								<Kbd>v</Kbd>
								<span>verify</span>
							</div>
							<span>•</span>
							<div className="flex items-center gap-2">
								<Kbd>Enter</Kbd>
								<span>view DNS</span>
							</div>
						</>
					) : (
						<span>No domains yet — claim a subdomain or add a custom domain below</span>
					)}
				</div>

				{/* Scrollable content */}
				<div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto">
					{/* Wisp Domains */}
					<div className="p-4 space-y-2">
						<div className="flex items-center justify-between mb-3">
							<p className="text-xs uppercase tracking-wider text-muted-foreground">Wisp Domains</p>
							{!userInfo?.isSupporter && <span className="text-xs text-muted-foreground">{wispDomains.length}/3</span>}
						</div>

						{domainsLoading ? (
							<div className="space-y-2">
								{['a', 'b'].map((id) => (
									<div key={id} className="p-3 border border-border/30">
										<SkeletonShimmer className="h-5 w-full" />
									</div>
								))}
							</div>
						) : wispDomains.length > 0 ? (
							<div className="space-y-2">
								{wispDomains.map((domain, idx) => {
									const isFocused = idx === focusedIndex
									return (
										<div
											key={domain.domain}
											ref={(el) => {
												itemRefs.current[idx] = el
											}}
											className={`flex items-center justify-between p-3 border transition-colors ${
												isFocused ? 'border-accent bg-accent/10' : 'border-border/30 hover:bg-muted/10'
											}`}
										>
											<div>
												<div className="flex items-center gap-2">
													<CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
													<span className="text-sm">{domain.domain}</span>
													<Badge variant="secondary" className="text-[10px]">
														wisp
													</Badge>
												</div>
												{domain.rkey && <p className="text-xs text-muted-foreground mt-1 ml-5">→ {domain.rkey}</p>}
											</div>
											<Button
												variant="ghost"
												size="sm"
												className="h-7 px-2 flex-shrink-0"
												onClick={() => onDeleteWispDomain(domain.domain)}
											>
												<Trash2 className="w-3 h-3" />
											</Button>
										</div>
									)
								})}
							</div>
						) : null}

						{/* Claim form */}
						{!domainsLoading && canClaimMore && (
							<div className="mt-2 p-3 border border-dashed border-border/50">
								<p className="text-xs text-muted-foreground mb-3">
									{wispDomains.length === 0
										? 'Claim your free wisp.place subdomain'
										: userInfo?.isSupporter
											? `Claim another (${wispDomains.length} claimed)`
											: `Claim another (${wispDomains.length}/3)`}
								</p>
								<div className="space-y-2">
									<Label htmlFor="wisp-handle" className="text-xs">
										Handle
									</Label>
									<div className="flex gap-2">
										<div className="flex-1 relative">
											<Input
												id="wisp-handle"
												placeholder="mysite"
												value={wispHandle}
												onChange={(e: ChangeEvent<HTMLInputElement>) => {
													setWispHandle(e.target.value)
													if (e.target.value.trim()) checkWispAvailability(e.target.value)
													else setWispAvailability({ available: null, checking: false })
												}}
												onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
													if (e.key === 'Enter') handleClaimWispDomain()
												}}
												disabled={isClaimingWisp}
												className="pr-24 h-8 text-sm"
											/>
											<span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
												.wisp.place
											</span>
										</div>
										<Button
											onClick={handleClaimWispDomain}
											disabled={!wispHandle.trim() || isClaimingWisp || wispAvailability.available !== true}
											size="sm"
											className="h-8 flex-shrink-0"
										>
											{isClaimingWisp ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Claim'}
										</Button>
									</div>
									{wispAvailability.checking && (
										<p className="text-xs text-muted-foreground flex items-center gap-1">
											<Loader2 className="w-3 h-3 animate-spin" />
											Checking...
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
							</div>
						)}

						{!domainsLoading && wispDomains.length === 3 && !userInfo?.isSupporter && (
							<p className="text-xs text-muted-foreground text-center py-2">
								Maximum of 3 wisp.place subdomains claimed
							</p>
						)}
					</div>

					{/* Custom Domains */}
					<div className="p-4 border-t border-border/30 space-y-2">
						<div className="flex items-center justify-between mb-3">
							<p className="text-xs uppercase tracking-wider text-muted-foreground">Custom Domains</p>
							<Button
								variant="outline"
								size="sm"
								className="h-7 text-xs px-3"
								onClick={() => setAddDomainModalOpen(true)}
							>
								+ Add Domain
							</Button>
						</div>

						{domainsLoading ? (
							<div className="space-y-2">
								{['a', 'b'].map((id) => (
									<div key={id} className="p-3 border border-border/30">
										<SkeletonShimmer className="h-5 w-full" />
									</div>
								))}
							</div>
						) : customDomains.length === 0 ? (
							<p className="text-xs text-muted-foreground py-2">No custom domains added yet</p>
						) : (
							<div className="space-y-2">
								{customDomains.map((domain, idx) => {
									const globalIndex = wispDomains.length + idx
									const isFocused = globalIndex === focusedIndex
									const isVerifying = verificationStatus[domain.id] === 'verifying'
									return (
										<div
											key={domain.id}
											ref={(el) => {
												itemRefs.current[globalIndex] = el
											}}
											className={`flex items-center justify-between p-3 border transition-colors ${
												isFocused ? 'border-accent bg-accent/10' : 'border-border/30 hover:bg-muted/10'
											}`}
										>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2 flex-wrap">
													{domain.verified ? (
														<CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
													) : (
														<XCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
													)}
													<span className="text-sm truncate">{domain.domain}</span>
													<Badge variant="outline" className="text-[10px]">
														custom
													</Badge>
													{domain.verified ? (
														<Badge variant="secondary" className="text-[10px]">
															✓ verified
														</Badge>
													) : (
														<Badge variant="secondary" className="text-[10px] text-yellow-500">
															⏳ pending
														</Badge>
													)}
												</div>
												{domain.rkey && domain.rkey !== 'self' && (
													<p className="text-xs text-muted-foreground mt-1 ml-5">→ {domain.rkey}</p>
												)}
												{verificationWarning?.id === domain.id && (
													<div className="flex items-start gap-1.5 mt-2 ml-5 text-xs text-yellow-600 dark:text-yellow-400">
														<AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
														<span>{verificationWarning.message}</span>
													</div>
												)}
											</div>
											<div className="flex items-center gap-1 flex-shrink-0 ml-2">
												<Button
													variant="outline"
													size="sm"
													className="h-7 text-xs px-2"
													onClick={() => setViewDomainDNS(domain.id)}
												>
													DNS
												</Button>
												{!domain.verified && (
													<Button
														variant="outline"
														size="sm"
														className="h-7 text-xs px-2"
														onClick={async () => {
															const result = await onVerifyDomain(domain.id)
															if (result.warning) {
																setVerificationWarning({ id: domain.id, message: result.warning })
															}
														}}
														disabled={isVerifying}
													>
														{isVerifying ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Verify'}
													</Button>
												)}
												<Button
													variant="ghost"
													size="sm"
													className="h-7 px-2"
													onClick={() => onDeleteCustomDomain(domain.id)}
												>
													<Trash2 className="w-3 h-3" />
												</Button>
											</div>
										</div>
									)
								})}
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Add Custom Domain Modal */}
			<Dialog open={addDomainModalOpen} onOpenChange={setAddDomainModalOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Add Custom Domain</DialogTitle>
						<DialogDescription>
							Enter your domain name. After adding, you'll see the DNS records to configure.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Label htmlFor="new-domain">Domain Name</Label>
							<Input
								id="new-domain"
								placeholder="example.com"
								value={customDomain}
								onChange={(e: ChangeEvent<HTMLInputElement>) => setCustomDomain(e.target.value)}
								onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
									if (e.key === 'Enter') handleAddCustomDomain()
								}}
							/>
							<p className="text-xs text-muted-foreground">
								After adding, click "View DNS" to see the records you need to configure.
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

			{/* View DNS Records Modal */}
			<Dialog open={viewDomainDNS !== null} onOpenChange={(open: boolean) => !open && setViewDomainDNS(null)}>
				<DialogContent className="sm:max-w-lg max-h-[80vh] overflow-hidden">
					<DialogHeader>
						<DialogTitle>DNS Configuration</DialogTitle>
						<DialogDescription>Add these DNS records to your domain provider</DialogDescription>
					</DialogHeader>
					{viewDomainDNS && userInfo && (
						<div className="relative max-h-[62vh] overflow-y-auto pr-2">
							<div className="pointer-events-none sticky top-0 z-10 h-3 bg-gradient-to-b from-background to-transparent" />
							{(() => {
								const domain = customDomains.find((d) => d.id === viewDomainDNS)
								if (!domain) return null
								return (
									<div className="space-y-4 py-4">
										<div className="p-3 bg-muted/30 rounded-lg">
											<p className="text-xs uppercase tracking-wide text-muted-foreground">Domain</p>
											<p className="font-mono text-sm mt-1">{domain.domain}</p>
										</div>

										<div className="space-y-3">
											<div className="p-4 bg-background rounded border border-border">
												<div className="flex items-center justify-between gap-3">
													<div>
														<p className="text-xs uppercase tracking-wide text-muted-foreground">Step 1</p>
														<p className="text-sm font-semibold">Verify ownership (TXT)</p>
													</div>
													<Badge variant="secondary" className="text-xs">
														Required
													</Badge>
												</div>
												<div className="mt-3 space-y-2">
													<div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
														<div className="min-w-0">
															<p className="text-xs text-muted-foreground">Name</p>
															<p className="font-mono text-sm select-all">_wisp.{domain.domain}</p>
														</div>
														<Button
															variant="outline"
															size="sm"
															onClick={() => copyToClipboard(`_wisp.${domain.domain}`, 'txt-name')}
														>
															{copiedField === 'txt-name' ? 'Copied' : 'Copy'}
														</Button>
													</div>
													<div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
														<div className="min-w-0">
															<p className="text-xs text-muted-foreground">Value</p>
															<p className="font-mono text-sm break-all select-all">{userInfo.did}</p>
														</div>
														<Button
															variant="outline"
															size="sm"
															onClick={() => copyToClipboard(userInfo.did, 'txt-value')}
														>
															{copiedField === 'txt-value' ? 'Copied' : 'Copy'}
														</Button>
													</div>
												</div>
											</div>

											<div className="p-4 bg-background rounded border border-border">
												<div className="flex items-center justify-between gap-3">
													<div>
														<p className="text-xs uppercase tracking-wide text-muted-foreground">Step 2</p>
														<p className="text-sm font-semibold">Point your domain (CNAME)</p>
													</div>
													<Badge variant="secondary" className="text-xs">
														Recommended
													</Badge>
												</div>
												<div className="mt-3 space-y-2">
													<div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
														<div className="min-w-0">
															<p className="text-xs text-muted-foreground">Name</p>
															<p className="font-mono text-sm select-all">{domain.domain}</p>
														</div>
														<Button
															variant="outline"
															size="sm"
															onClick={() => copyToClipboard(domain.domain, 'cname-name')}
														>
															{copiedField === 'cname-name' ? 'Copied' : 'Copy'}
														</Button>
													</div>
													<div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
														<div className="min-w-0">
															<p className="text-xs text-muted-foreground">Value</p>
															<p className="font-mono text-sm select-all">{domain.id}.dns.wisp.place</p>
														</div>
														<Button
															variant="outline"
															size="sm"
															onClick={() => copyToClipboard(`${domain.id}.dns.wisp.place`, 'cname-value')}
														>
															{copiedField === 'cname-value' ? 'Copied' : 'Copy'}
														</Button>
													</div>
												</div>
												<div className="mt-3 flex gap-2 rounded-md border border-blue-500/20 bg-blue-500/10 p-2 text-xs text-blue-200">
													<AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-blue-300" />
													<p>
														Some DNS providers (like Cloudflare) flatten CNAMEs to A records. That&apos;s okay and
														won&apos;t affect verification.
													</p>
												</div>
											</div>

											<details className="p-4 bg-background rounded border border-border">
												<summary className="text-sm font-semibold cursor-pointer select-none">
													Use A Records Instead (Fallback)
												</summary>
												<div className="mt-3">
													<div className="p-2 bg-yellow-500/10 border border-yellow-500/20 rounded mb-3 flex gap-2">
														<AlertCircle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
														<p className="text-sm text-yellow-700 dark:text-yellow-500">
															<strong>Warning:</strong> A records disable GeoDNS. Your site will always be served from
															the single region you choose.
														</p>
													</div>
													<div className="space-y-3">
														{HOSTING_NODES.map((node) => (
															<div key={node.ip} className="space-y-2 pl-3 border-l-2 border-muted">
																<div className="font-semibold text-muted-foreground mb-1">{node.region}</div>
																<div className="font-mono text-xs space-y-1">
																	<div>
																		<span className="text-muted-foreground">Name:</span>{' '}
																		<span className="select-all">{domain.domain}</span>
																	</div>
																	<div>
																		<span className="text-muted-foreground">Type:</span> <span>A</span>
																	</div>
																</div>
																<div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs">
																	<div className="min-w-0">
																		<p className="text-xs text-muted-foreground">Value</p>
																		<p className="select-all">{node.ip}</p>
																	</div>
																	<Button
																		variant="outline"
																		size="sm"
																		onClick={() => copyToClipboard(node.ip, `a-value-${node.ip}`)}
																	>
																		{copiedField === `a-value-${node.ip}` ? 'Copied' : 'Copy'}
																	</Button>
																</div>
															</div>
														))}
													</div>
													<p className="text-sm text-muted-foreground mt-3">
														Choose the region closest to your primary audience.
													</p>
												</div>
											</details>
										</div>

										<div className="p-3 bg-muted/30 rounded-lg">
											<p className="text-sm text-muted-foreground">
												After configuring DNS, click "Verify DNS" to check everything. DNS changes can take a few
												minutes to propagate.
											</p>
										</div>
									</div>
								)
							})()}
							<div className="pointer-events-none sticky bottom-0 z-10 flex h-8 items-end justify-center bg-gradient-to-t from-background to-transparent">
								<span className="text-[10px] text-muted-foreground">Scroll for more</span>
							</div>
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setViewDomainDNS(null)} className="w-full sm:w-auto">
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	)
}
