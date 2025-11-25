import { useState } from 'react'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle
} from '@public/components/ui/card'
import { Button } from '@public/components/ui/button'
import { Input } from '@public/components/ui/input'
import { Label } from '@public/components/ui/label'
import { Badge } from '@public/components/ui/badge'
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogFooter
} from '@public/components/ui/dialog'
import {
	CheckCircle2,
	XCircle,
	Loader2,
	Trash2
} from 'lucide-react'
import type { WispDomain, CustomDomain } from '../hooks/useDomainData'
import type { UserInfo } from '../hooks/useUserInfo'

interface DomainsTabProps {
	wispDomains: WispDomain[]
	customDomains: CustomDomain[]
	domainsLoading: boolean
	verificationStatus: { [id: string]: 'idle' | 'verifying' | 'success' | 'error' }
	userInfo: UserInfo | null
	onAddCustomDomain: (domain: string) => Promise<{ success: boolean; id?: string }>
	onVerifyDomain: (id: string) => Promise<void>
	onDeleteCustomDomain: (id: string) => Promise<boolean>
	onDeleteWispDomain: (domain: string) => Promise<boolean>
	onClaimWispDomain: (handle: string) => Promise<{ success: boolean; error?: string }>
	onCheckWispAvailability: (handle: string) => Promise<{ available: boolean | null }>
}

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
	onCheckWispAvailability
}: DomainsTabProps) {
	// Wisp domain claim state
	const [wispHandle, setWispHandle] = useState('')
	const [isClaimingWisp, setIsClaimingWisp] = useState(false)
	const [wispAvailability, setWispAvailability] = useState<{
		available: boolean | null
		checking: boolean
	}>({ available: null, checking: false })

	// Custom domain modal state
	const [addDomainModalOpen, setAddDomainModalOpen] = useState(false)
	const [customDomain, setCustomDomain] = useState('')
	const [isAddingDomain, setIsAddingDomain] = useState(false)
	const [viewDomainDNS, setViewDomainDNS] = useState<string | null>(null)

	const checkWispAvailability = async (handle: string) => {
		const trimmedHandle = handle.trim().toLowerCase()
		if (!trimmedHandle) {
			setWispAvailability({ available: null, checking: false })
			return
		}

		setWispAvailability({ available: null, checking: true })
		const result = await onCheckWispAvailability(trimmedHandle)
		setWispAvailability({ available: result.available, checking: false })
	}

	const handleClaimWispDomain = async () => {
		const trimmedHandle = wispHandle.trim().toLowerCase()
		if (!trimmedHandle) {
			alert('Please enter a handle')
			return
		}

		setIsClaimingWisp(true)
		const result = await onClaimWispDomain(trimmedHandle)
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
			// Automatically show DNS configuration for the newly added domain
			if (result.id) {
				setViewDomainDNS(result.id)
			}
		}
	}

	return (
		<>
			<div className="space-y-4 min-h-[400px]">
				<Card>
					<CardHeader>
						<CardTitle>wisp.place Subdomains</CardTitle>
						<CardDescription>
							Your free subdomains on the wisp.place network (up to 3)
						</CardDescription>
					</CardHeader>
					<CardContent>
						{domainsLoading ? (
							<div className="space-y-4">
								<div className="space-y-2">
									{[...Array(2)].map((_, i) => (
										<div
											key={i}
											className="flex items-center justify-between p-3 border border-border rounded-lg"
										>
											<div className="flex flex-col gap-2 flex-1">
												<div className="flex items-center gap-2">
													<SkeletonShimmer className="h-4 w-4 rounded-full" />
													<SkeletonShimmer className="h-4 w-40" />
												</div>
												<SkeletonShimmer className="h-3 w-32 ml-6" />
											</div>
											<SkeletonShimmer className="h-8 w-8" />
										</div>
									))}
								</div>
								<div className="p-4 bg-muted/30 rounded-lg space-y-3">
									<SkeletonShimmer className="h-4 w-full" />
									<div className="space-y-2">
										<SkeletonShimmer className="h-4 w-24" />
										<SkeletonShimmer className="h-10 w-full" />
									</div>
									<SkeletonShimmer className="h-10 w-full" />
								</div>
							</div>
						) : (
							<div className="space-y-4">
								{wispDomains.length > 0 && (
									<div className="space-y-2">
										{wispDomains.map((domain) => (
											<div
												key={domain.domain}
												className="flex items-center justify-between p-3 border border-border rounded-lg"
											>
												<div className="flex flex-col gap-1 flex-1">
													<div className="flex items-center gap-2">
														<CheckCircle2 className="w-4 h-4 text-green-500" />
														<span className="font-mono">
															{domain.domain}
														</span>
													</div>
													{domain.rkey && (
														<p className="text-xs text-muted-foreground ml-6">
															→ Mapped to site: {domain.rkey}
														</p>
													)}
												</div>
												<Button
													variant="ghost"
													size="sm"
													onClick={() => onDeleteWispDomain(domain.domain)}
												>
													<Trash2 className="w-4 h-4" />
												</Button>
											</div>
										))}
									</div>
								)}

								{wispDomains.length < 3 && (
									<div className="p-4 bg-muted/30 rounded-lg">
										<p className="text-sm text-muted-foreground mb-4">
											{wispDomains.length === 0
												? 'Claim your free wisp.place subdomain'
												: `Claim another wisp.place subdomain (${wispDomains.length}/3)`}
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
								)}

								{wispDomains.length === 3 && (
									<div className="p-3 bg-muted/30 rounded-lg text-center">
										<p className="text-sm text-muted-foreground">
											You have claimed the maximum of 3 wisp.place subdomains
										</p>
									</div>
								)}
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
							<div className="space-y-2">
								{[...Array(2)].map((_, i) => (
									<div
										key={i}
										className="flex items-center justify-between p-3 border border-border rounded-lg"
									>
										<div className="flex flex-col gap-2 flex-1">
											<div className="flex items-center gap-2">
												<SkeletonShimmer className="h-4 w-4 rounded-full" />
												<SkeletonShimmer className="h-4 w-48" />
											</div>
											<SkeletonShimmer className="h-3 w-36 ml-6" />
										</div>
										<div className="flex items-center gap-2">
											<SkeletonShimmer className="h-8 w-20" />
											<SkeletonShimmer className="h-8 w-20" />
											<SkeletonShimmer className="h-8 w-8" />
										</div>
									</div>
								))}
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
														onVerifyDomain(domain.id)
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
													onDeleteCustomDomain(
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
													Note: Some DNS providers (like Cloudflare) flatten CNAMEs to A records - this is fine and won't affect verification.
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
		</>
	)
}
