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
import { Globe, Upload, CheckCircle2, Loader2 } from 'lucide-react'
import Layout from '@public/layouts'

type OnboardingStep = 'domain' | 'upload' | 'complete'

function Onboarding() {
	const [step, setStep] = useState<OnboardingStep>('domain')
	const [handle, setHandle] = useState('')
	const [isCheckingAvailability, setIsCheckingAvailability] = useState(false)
	const [isAvailable, setIsAvailable] = useState<boolean | null>(null)
	const [domain, setDomain] = useState('')
	const [isClaimingDomain, setIsClaimingDomain] = useState(false)
	const [claimedDomain, setClaimedDomain] = useState('')

	const [siteName, setSiteName] = useState('')
	const [selectedFiles, setSelectedFiles] = useState<FileList | null>(null)
	const [isUploading, setIsUploading] = useState(false)
	const [uploadProgress, setUploadProgress] = useState('')

	// Check domain availability as user types
	useEffect(() => {
		if (!handle || handle.length < 3) {
			setIsAvailable(null)
			setDomain('')
			return
		}

		const timeoutId = setTimeout(async () => {
			setIsCheckingAvailability(true)
			try {
				const response = await fetch(
					`/api/domain/check?handle=${encodeURIComponent(handle)}`
				)
				const data = await response.json()
				setIsAvailable(data.available)
				setDomain(data.domain || '')
			} catch (err) {
				console.error('Error checking availability:', err)
				setIsAvailable(false)
			} finally {
				setIsCheckingAvailability(false)
			}
		}, 500)

		return () => clearTimeout(timeoutId)
	}, [handle])

	const handleClaimDomain = async () => {
		if (!handle || !isAvailable) return

		setIsClaimingDomain(true)
		try {
			const response = await fetch('/api/domain/claim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ handle })
			})

			const data = await response.json()
			if (data.success) {
				setClaimedDomain(data.domain)
				setStep('upload')
			} else {
				alert('Failed to claim domain. Please try again.')
			}
		} catch (err) {
			console.error('Error claiming domain:', err)
			alert('Failed to claim domain. Please try again.')
		} finally {
			setIsClaimingDomain(false)
		}
	}

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files && e.target.files.length > 0) {
			setSelectedFiles(e.target.files)
		}
	}

	const handleUpload = async () => {
		if (!siteName) {
			alert('Please enter a site name')
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
				// Redirect to the claimed domain
				setTimeout(() => {
					window.location.href = `https://${claimedDomain}`
				}, 1500)
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

	const handleSkipUpload = () => {
		// Redirect to editor without uploading
		window.location.href = '/editor'
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
				</div>
			</header>

			<div className="container mx-auto px-4 py-12 max-w-2xl">
				{/* Progress indicator */}
				<div className="mb-8">
					<div className="flex items-center justify-center gap-2 mb-4">
						<div
							className={`w-8 h-8 rounded-full flex items-center justify-center ${
								step === 'domain'
									? 'bg-primary text-primary-foreground'
									: 'bg-green-500 text-white'
							}`}
						>
							{step === 'domain' ? (
								'1'
							) : (
								<CheckCircle2 className="w-5 h-5" />
							)}
						</div>
						<div className="w-16 h-0.5 bg-border"></div>
						<div
							className={`w-8 h-8 rounded-full flex items-center justify-center ${
								step === 'upload'
									? 'bg-primary text-primary-foreground'
									: step === 'domain'
										? 'bg-muted text-muted-foreground'
										: 'bg-green-500 text-white'
							}`}
						>
							{step === 'complete' ? (
								<CheckCircle2 className="w-5 h-5" />
							) : (
								'2'
							)}
						</div>
					</div>
					<div className="text-center">
						<h1 className="text-2xl font-bold mb-2">
							{step === 'domain' && 'Claim Your Free Domain'}
							{step === 'upload' && 'Deploy Your First Site'}
							{step === 'complete' && 'All Set!'}
						</h1>
						<p className="text-muted-foreground">
							{step === 'domain' &&
								'Choose a subdomain on wisp.place'}
							{step === 'upload' &&
								'Upload your site or start with an empty one'}
							{step === 'complete' && 'Redirecting to your site...'}
						</p>
					</div>
				</div>

				{/* Domain registration step */}
				{step === 'domain' && (
					<Card>
						<CardHeader>
							<CardTitle>Choose Your Domain</CardTitle>
							<CardDescription>
								Pick a unique handle for your free *.wisp.place
								subdomain
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="handle">Your Handle</Label>
								<div className="flex gap-2">
									<div className="relative flex-1">
										<Input
											id="handle"
											placeholder="my-awesome-site"
											value={handle}
											onChange={(e) =>
												setHandle(
													e.target.value
														.toLowerCase()
														.replace(/[^a-z0-9-]/g, '')
												)
											}
											className="pr-10"
										/>
										{isCheckingAvailability && (
											<Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
										)}
										{!isCheckingAvailability &&
											isAvailable !== null && (
												<div
													className={`absolute right-3 top-1/2 -translate-y-1/2 ${
														isAvailable
															? 'text-green-500'
															: 'text-red-500'
													}`}
												>
													{isAvailable ? '✓' : '✗'}
												</div>
											)}
									</div>
								</div>
								{domain && (
									<p className="text-sm text-muted-foreground">
										Your domain will be:{' '}
										<span className="font-mono">{domain}</span>
									</p>
								)}
								{isAvailable === false && handle.length >= 3 && (
									<p className="text-sm text-red-500">
										This handle is not available or invalid
									</p>
								)}
							</div>

							<Button
								onClick={handleClaimDomain}
								disabled={
									!isAvailable ||
									isClaimingDomain ||
									isCheckingAvailability
								}
								className="w-full"
							>
								{isClaimingDomain ? (
									<>
										<Loader2 className="w-4 h-4 mr-2 animate-spin" />
										Claiming Domain...
									</>
								) : (
									<>Claim Domain</>
								)}
							</Button>
						</CardContent>
					</Card>
				)}

				{/* Upload step */}
				{step === 'upload' && (
					<Card>
						<CardHeader>
							<CardTitle>Deploy Your Site</CardTitle>
							<CardDescription>
								Upload your static site files or start with an empty
								site (you can upload later)
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-6">
							<div className="p-4 bg-green-500/10 border border-green-500/20 rounded-lg">
								<div className="flex items-center gap-2 text-green-600 dark:text-green-400">
									<CheckCircle2 className="w-4 h-4" />
									<span className="font-medium">
										Domain claimed: {claimedDomain}
									</span>
								</div>
							</div>

							<div className="space-y-2">
								<Label htmlFor="site-name">Site Name</Label>
								<Input
									id="site-name"
									placeholder="my-site"
									value={siteName}
									onChange={(e) => setSiteName(e.target.value)}
								/>
								<p className="text-xs text-muted-foreground">
									A unique identifier for this site in your account
								</p>
							</div>

							<div className="space-y-2">
								<Label>Upload Files (Optional)</Label>
								<div className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-accent transition-colors">
									<Upload className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
									<input
										type="file"
										id="file-upload"
										multiple
										onChange={handleFileSelect}
										className="hidden"
										{...(({ webkitdirectory: '', directory: '' } as any))}
									/>
									<label
										htmlFor="file-upload"
										className="cursor-pointer"
									>
										<Button
											variant="outline"
											type="button"
											onClick={() =>
												document
													.getElementById('file-upload')
													?.click()
											}
										>
											Choose Folder
										</Button>
									</label>
									{selectedFiles && selectedFiles.length > 0 && (
										<p className="text-sm text-muted-foreground mt-3">
											{selectedFiles.length} files selected
										</p>
									)}
								</div>
								<p className="text-xs text-muted-foreground">
									Supported: HTML, CSS, JS, images, fonts, and more
								</p>
							</div>

							{uploadProgress && (
								<div className="p-4 bg-muted rounded-lg">
									<div className="flex items-center gap-2">
										<Loader2 className="w-4 h-4 animate-spin" />
										<span className="text-sm">
											{uploadProgress}
										</span>
									</div>
								</div>
							)}

							<div className="flex gap-3">
								<Button
									onClick={handleSkipUpload}
									variant="outline"
									className="flex-1"
									disabled={isUploading}
								>
									Skip for Now
								</Button>
								<Button
									onClick={handleUpload}
									className="flex-1"
									disabled={!siteName || isUploading}
								>
									{isUploading ? (
										<>
											<Loader2 className="w-4 h-4 mr-2 animate-spin" />
											Uploading...
										</>
									) : (
										<>
											{selectedFiles && selectedFiles.length > 0
												? 'Upload & Deploy'
												: 'Create Empty Site'}
										</>
									)}
								</Button>
							</div>
						</CardContent>
					</Card>
				)}
			</div>
		</div>
	)
}

const root = createRoot(document.getElementById('elysia')!)
root.render(
	<Layout>
		<Onboarding />
	</Layout>
)
