import { useState } from 'react'
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
import { RadioGroup, RadioGroupItem } from '@public/components/ui/radio-group'
import {
	Globe,
	Upload,
	Settings,
	ExternalLink,
	CheckCircle2,
	XCircle,
	AlertCircle
} from 'lucide-react'

import Layout from '@public/layouts'

// Mock user data - replace with actual auth
const mockUser = {
	did: 'did:plc:abc123xyz',
	handle: 'alice.bsky.social',
	wispSubdomain: 'alice'
}

function Dashboard() {
	const [customDomain, setCustomDomain] = useState('')
	const [verificationStatus, setVerificationStatus] = useState<
		'idle' | 'verifying' | 'success' | 'error'
	>('idle')
	const [selectedSite, setSelectedSite] = useState('')

	const [configureModalOpen, setConfigureModalOpen] = useState(false)
	const [addDomainModalOpen, setAddDomainModalOpen] = useState(false)
	const [currentSite, setCurrentSite] = useState<{
		id: string
		name: string
		domain: string | null
	} | null>(null)
	const [selectedDomain, setSelectedDomain] = useState<string>('')

	// Mock sites data
	const [sites] = useState([
		{
			id: '1',
			name: 'my-blog',
			domain: 'alice.wisp.place',
			status: 'active'
		},
		{ id: '2', name: 'portfolio', domain: null, status: 'active' },
		{
			id: '3',
			name: 'docs-site',
			domain: 'docs.example.com',
			status: 'active'
		}
	])

	const availableDomains = [
		{ value: 'alice.wisp.place', label: 'alice.wisp.place', type: 'wisp' },
		{
			value: 'docs.example.com',
			label: 'docs.example.com',
			type: 'custom'
		},
		{ value: 'none', label: 'No domain (use default URL)', type: 'none' }
	]

	const handleVerifyDNS = async () => {
		setVerificationStatus('verifying')
		// Simulate DNS verification
		setTimeout(() => {
			setVerificationStatus('success')
		}, 2000)
	}

	const handleConfigureSite = (site: {
		id: string
		name: string
		domain: string | null
	}) => {
		setCurrentSite(site)
		setSelectedDomain(site.domain || 'none')
		setConfigureModalOpen(true)
	}

	const handleSaveConfiguration = () => {
		console.log(
			'[v0] Saving configuration for site:',
			currentSite?.name,
			'with domain:',
			selectedDomain
		)
		// TODO: Implement actual save logic
		setConfigureModalOpen(false)
	}

	const getSiteUrl = (site: { name: string; domain: string | null }) => {
		if (site.domain) {
			return `https://${site.domain}`
		}
		return `https://sites.wisp.place/${mockUser.did}/${site.name}`
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
							{mockUser.handle}
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
					<TabsList className="grid w-full grid-cols-3 max-w-md">
						<TabsTrigger value="sites">Sites</TabsTrigger>
						<TabsTrigger value="domains">Domains</TabsTrigger>
						<TabsTrigger value="upload">Upload</TabsTrigger>
					</TabsList>

					{/* Sites Tab */}
					<TabsContent value="sites" className="space-y-4 min-h-[400px]">
						<Card>
							<CardHeader>
								<CardTitle>Your Sites</CardTitle>
								<CardDescription>
									View and manage all your deployed sites
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								{sites.map((site) => (
									<div
										key={site.id}
										className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-muted/50 transition-colors"
									>
										<div className="flex-1">
											<div className="flex items-center gap-3 mb-2">
												<h3 className="font-semibold text-lg">
													{site.name}
												</h3>
												<Badge
													variant="secondary"
													className="text-xs"
												>
													{site.status}
												</Badge>
											</div>
											<a
												href={getSiteUrl(site)}
												target="_blank"
												rel="noopener noreferrer"
												className="text-sm text-accent hover:text-accent/80 flex items-center gap-1"
											>
												{site.domain ||
													`sites.wisp.place/${mockUser.did}/${site.name}`}
												<ExternalLink className="w-3 h-3" />
											</a>
										</div>
										<Button
											variant="outline"
											size="sm"
											onClick={() =>
												handleConfigureSite(site)
											}
										>
											<Settings className="w-4 h-4 mr-2" />
											Configure
										</Button>
									</div>
								))}
							</CardContent>
						</Card>
					</TabsContent>

					{/* Domains Tab */}
					<TabsContent value="domains" className="space-y-4 min-h-[400px]">
						<Card>
							<CardHeader>
								<CardTitle>wisp.place Subdomain</CardTitle>
								<CardDescription>
									Your free subdomain on the wisp.place
									network
								</CardDescription>
							</CardHeader>
							<CardContent>
								<div className="flex items-center gap-2 p-4 bg-muted/50 rounded-lg">
									<CheckCircle2 className="w-5 h-5 text-green-500" />
									<span className="font-mono text-lg">
										{mockUser.wispSubdomain}.wisp.place
									</span>
								</div>
								<p className="text-sm text-muted-foreground mt-3">
									Configure which site uses this domain in the
									Sites tab
								</p>
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

								<div className="space-y-2">
									<div className="flex items-center justify-between p-3 border border-border rounded-lg">
										<div className="flex items-center gap-2">
											<CheckCircle2 className="w-4 h-4 text-green-500" />
											<span className="font-mono">
												docs.example.com
											</span>
										</div>
										<Badge variant="secondary">
											Verified
										</Badge>
									</div>
								</div>
							</CardContent>
						</Card>
					</TabsContent>

					{/* Upload Tab */}
					<TabsContent value="upload" className="space-y-4 min-h-[400px]">
						<Card>
							<CardHeader>
								<CardTitle>Upload Site</CardTitle>
								<CardDescription>
									Deploy a new site from a folder or Git
									repository
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-6">
								<div className="space-y-2">
									<Label htmlFor="site-name">Site Name</Label>
									<Input
										id="site-name"
										placeholder="my-awesome-site"
									/>
								</div>

								<div className="grid md:grid-cols-2 gap-4">
									<Card className="border-2 border-dashed hover:border-accent transition-colors cursor-pointer">
										<CardContent className="flex flex-col items-center justify-center p-8 text-center">
											<Upload className="w-12 h-12 text-muted-foreground mb-4" />
											<h3 className="font-semibold mb-2">
												Upload Folder
											</h3>
											<p className="text-sm text-muted-foreground mb-4">
												Drag and drop or click to upload
												your static site files
											</p>
											<Button variant="outline">
												Choose Folder
											</Button>
										</CardContent>
									</Card>

									<Card className="border-2 border-dashed hover:border-accent transition-colors">
										<CardContent className="flex flex-col items-center justify-center p-8 text-center">
											<Globe className="w-12 h-12 text-muted-foreground mb-4" />
											<h3 className="font-semibold mb-2">
												Connect Git Repository
											</h3>
											<p className="text-sm text-muted-foreground mb-4">
												Link your GitHub, GitLab, or any
												Git repository
											</p>
											<Button variant="outline">
												Connect Git
											</Button>
										</CardContent>
									</Card>
								</div>
							</CardContent>
						</Card>
					</TabsContent>
				</Tabs>
			</div>

			<Dialog
				open={configureModalOpen}
				onOpenChange={setConfigureModalOpen}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Configure Site Domain</DialogTitle>
						<DialogDescription>
							Choose which domain {currentSite?.name} should use
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<RadioGroup
							value={selectedDomain}
							onValueChange={setSelectedDomain}
						>
							{availableDomains.map((domain) => (
								<div
									key={domain.value}
									className="flex items-center space-x-2"
								>
									<RadioGroupItem
										value={domain.value}
										id={domain.value}
									/>
									<Label
										htmlFor={domain.value}
										className="flex-1 cursor-pointer"
									>
										<div className="flex items-center justify-between">
											<span className="font-mono text-sm">
												{domain.label}
											</span>
											{domain.type === 'wisp' && (
												<Badge
													variant="secondary"
													className="text-xs"
												>
													Free
												</Badge>
											)}
											{domain.type === 'custom' && (
												<Badge
													variant="outline"
													className="text-xs"
												>
													Custom
												</Badge>
											)}
										</div>
									</Label>
								</div>
							))}
						</RadioGroup>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setConfigureModalOpen(false)}
						>
							Cancel
						</Button>
						<Button onClick={handleSaveConfiguration}>
							Save Configuration
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={addDomainModalOpen}
				onOpenChange={setAddDomainModalOpen}
			>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Add Custom Domain</DialogTitle>
						<DialogDescription>
							Configure DNS records to verify your domain
							ownership
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4 py-4">
						<div className="space-y-2">
							<Label htmlFor="new-domain">Domain Name</Label>
							<Input
								id="new-domain"
								placeholder="example.com"
								value={customDomain}
								onChange={(e) =>
									setCustomDomain(e.target.value)
								}
							/>
						</div>

						{customDomain && (
							<div className="space-y-4 p-4 bg-muted/30 rounded-lg border border-border">
								<div>
									<h4 className="font-semibold mb-2 flex items-center gap-2">
										<AlertCircle className="w-4 h-4 text-accent" />
										DNS Configuration Required
									</h4>
									<p className="text-sm text-muted-foreground mb-4">
										Add these DNS records to your domain
										provider:
									</p>
								</div>

								<div className="space-y-3">
									<div className="p-3 bg-background rounded border border-border">
										<div className="flex justify-between items-start mb-1">
											<span className="text-xs font-semibold text-muted-foreground">
												TXT Record
											</span>
										</div>
										<div className="font-mono text-sm space-y-1">
											<div>
												<span className="text-muted-foreground">
													Name:
												</span>{' '}
												_wisp
											</div>
											<div>
												<span className="text-muted-foreground">
													Value:
												</span>{' '}
												{mockUser.did}
											</div>
										</div>
									</div>

									<div className="p-3 bg-background rounded border border-border">
										<div className="flex justify-between items-start mb-1">
											<span className="text-xs font-semibold text-muted-foreground">
												CNAME Record
											</span>
										</div>
										<div className="font-mono text-sm space-y-1">
											<div>
												<span className="text-muted-foreground">
													Name:
												</span>{' '}
												@ or {customDomain}
											</div>
											<div>
												<span className="text-muted-foreground">
													Value:
												</span>{' '}
												abc123.dns.wisp.place
											</div>
										</div>
									</div>
								</div>
							</div>
						)}
					</div>
					<DialogFooter className="flex-col sm:flex-row gap-2">
						<Button
							variant="outline"
							onClick={() => {
								setAddDomainModalOpen(false)
								setCustomDomain('')
								setVerificationStatus('idle')
							}}
							className="w-full sm:w-auto"
						>
							Cancel
						</Button>
						<Button
							onClick={handleVerifyDNS}
							disabled={
								!customDomain ||
								verificationStatus === 'verifying'
							}
							className="w-full sm:w-auto"
						>
							{verificationStatus === 'verifying' ? (
								<>Verifying DNS...</>
							) : verificationStatus === 'success' ? (
								<>
									<CheckCircle2 className="w-4 h-4 mr-2" />
									Verified
								</>
							) : verificationStatus === 'error' ? (
								<>
									<XCircle className="w-4 h-4 mr-2" />
									Verification Failed
								</>
							) : (
								<>Verify DNS Records</>
							)}
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
