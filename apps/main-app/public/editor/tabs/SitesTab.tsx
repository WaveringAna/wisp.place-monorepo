import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle
} from '@public/components/ui/card'
import { Button } from '@public/components/ui/button'
import { Badge } from '@public/components/ui/badge'
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import {
	Globe,
	ExternalLink,
	CheckCircle2,
	AlertCircle,
	Loader2,
	RefreshCw,
	Settings
} from 'lucide-react'
import type { SiteWithDomains } from '../hooks/useSiteData'
import type { UserInfo } from '../hooks/useUserInfo'

interface SitesTabProps {
	sites: SiteWithDomains[]
	sitesLoading: boolean
	isSyncing: boolean
	userInfo: UserInfo | null
	onSyncSites: () => Promise<void>
	onConfigureSite: (site: SiteWithDomains) => void
}

export function SitesTab({
	sites,
	sitesLoading,
	isSyncing,
	userInfo,
	onSyncSites,
	onConfigureSite
}: SitesTabProps) {
	const getSiteUrl = (site: SiteWithDomains) => {
		// Use the first mapped domain if available
		if (site.domains && site.domains.length > 0) {
			return `https://${site.domains[0].domain}`
		}

		// Default fallback URL - use handle instead of DID
		if (!userInfo) return '#'
		return `https://sites.wisp.place/${userInfo.handle}/${site.rkey}`
	}

	const getSiteDomainName = (site: SiteWithDomains) => {
		// Return the first domain if available
		if (site.domains && site.domains.length > 0) {
			return site.domains[0].domain
		}

		// Use handle instead of DID for display
		if (!userInfo) return `sites.wisp.place/.../${site.rkey}`
		return `sites.wisp.place/${userInfo.handle}/${site.rkey}`
	}

	return (
		<div className="space-y-4 min-h-[400px]">
			<Card>
				<CardHeader>
					<div className="flex items-center justify-between">
						<div>
							<CardTitle>Your Sites</CardTitle>
							<CardDescription>
								View and manage all your deployed sites
							</CardDescription>
						</div>
						{userInfo && (
							<Button
								variant="outline"
								size="sm"
								asChild
							>
								<a
									href={`https://pdsls.dev/at://${userInfo.did}/place.wisp.fs`}
									target="_blank"
									rel="noopener noreferrer"
								>
									<ExternalLink className="w-4 h-4 mr-2" />
									View in PDS
								</a>
							</Button>
						)}
					</div>
				</CardHeader>
				<CardContent className="space-y-4">
					{sitesLoading ? (
						<div className="space-y-4">
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

									{/* Display all mapped domains */}
									{site.domains && site.domains.length > 0 ? (
										<div className="space-y-1">
											{site.domains.map((domainInfo, idx) => (
												<div key={`${domainInfo.domain}-${idx}`} className="flex items-center gap-2">
													<a
														href={`https://${domainInfo.domain}`}
														target="_blank"
														rel="noopener noreferrer"
														className="text-sm text-accent hover:text-accent/80 flex items-center gap-1"
													>
														<Globe className="w-3 h-3" />
														{domainInfo.domain}
														<ExternalLink className="w-3 h-3" />
													</a>
													<Badge
														variant={domainInfo.type === 'wisp' ? 'default' : 'outline'}
														className="text-xs"
													>
														{domainInfo.type}
													</Badge>
													{domainInfo.type === 'custom' && (
														<Badge
															variant={domainInfo.verified ? 'default' : 'secondary'}
															className="text-xs"
														>
															{domainInfo.verified ? (
																<>
																	<CheckCircle2 className="w-3 h-3 mr-1" />
																	verified
																</>
															) : (
																<>
																	<AlertCircle className="w-3 h-3 mr-1" />
																	pending
																</>
															)}
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
											className="text-sm text-muted-foreground hover:text-accent flex items-center gap-1"
										>
											{getSiteDomainName(site)}
											<ExternalLink className="w-3 h-3" />
										</a>
									)}
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={() => onConfigureSite(site)}
								>
									<Settings className="w-4 h-4 mr-2" />
									Configure
								</Button>
							</div>
						))
					)}
				</CardContent>
			</Card>

			<div className="p-4 bg-muted/30 rounded-lg border-l-4 border-yellow-500/50">
				<div className="flex items-start gap-2">
					<AlertCircle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 mt-0.5 shrink-0" />
					<div className="flex-1 space-y-1">
						<p className="text-xs font-semibold text-yellow-600 dark:text-yellow-400">
							Note about sites.wisp.place URLs
						</p>
						<p className="text-xs text-muted-foreground">
							Complex sites hosted on <code className="px-1 py-0.5 bg-background rounded text-xs">sites.wisp.place</code> may have broken assets if they use absolute paths (e.g., <code className="px-1 py-0.5 bg-background rounded text-xs">/folder/script.js</code>) in CSS or JavaScript files. While HTML paths are automatically rewritten, CSS and JS files are served as-is. For best results, use a wisp.place subdomain or custom domain, or ensure your site uses relative paths.
						</p>
					</div>
				</div>
			</div>
		</div>
	)
}
