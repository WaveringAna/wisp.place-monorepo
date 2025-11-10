import { useState, useRef, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
	ArrowRight,
	Shield,
	Zap,
	Globe,
	Lock,
	Code,
	Server
} from 'lucide-react'

import Layout from '@public/layouts'
import { Button } from '@public/components/ui/button'
import { Card } from '@public/components/ui/card'
import { BlueskyPostList, BlueskyProfile, BlueskyPost, AtProtoProvider, useLatestRecord, type AtProtoStyles, type FeedPostRecord } from 'atproto-ui'
import 'atproto-ui/styles.css'

const LatestPostWithPrefetch: React.FC<{ did: string }> = ({ did }) => {
	// Fetch once with the hook
	const { record, rkey, loading } = useLatestRecord<FeedPostRecord>(
		did,
		'app.bsky.feed.post'
	)

	if (loading) return <span>Loading…</span>
	if (!record || !rkey) return <span>No posts yet.</span>

	// Pass prefetched record—BlueskyPost won't re-fetch it
	return <BlueskyPost did={did} rkey={rkey} record={record} showParent={true} />
}

function App() {
	const [showForm, setShowForm] = useState(false)
	const [checkingAuth, setCheckingAuth] = useState(true)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		// Check authentication status on mount
		const checkAuth = async () => {
			try {
				const response = await fetch('/api/auth/status', {
					credentials: 'include'
				})
				const data = await response.json()
				if (data.authenticated) {
					// User is already authenticated, redirect to editor
					window.location.href = '/editor'
					return
				}
			} catch (error) {
				console.error('Auth check failed:', error)
			} finally {
				setCheckingAuth(false)
			}
		}

		checkAuth()
	}, [])

	useEffect(() => {
		if (showForm) {
			setTimeout(() => inputRef.current?.focus(), 500)
		}
	}, [showForm])

	if (checkingAuth) {
		return (
			<div className="min-h-screen bg-background flex items-center justify-center">
				<div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin"></div>
			</div>
		)
	}

	return (
		<>
			<div className="min-h-screen">
				{/* Header */}
				<header className="border-b border-border/40 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
					<div className="container mx-auto px-4 py-4 flex items-center justify-between">
						<div className="flex items-center gap-2">
							<img src="/transparent-full-size-ico.png" alt="wisp.place" className="w-8 h-8" />
							<span className="text-xl font-semibold text-foreground">
								wisp.place
							</span>
						</div>
						<div className="flex items-center gap-3">
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setShowForm(true)}
							>
								Sign In
							</Button>
							<Button
								size="sm"
								className="bg-accent text-accent-foreground hover:bg-accent/90"
								onClick={() => setShowForm(true)}
							>
								Get Started
							</Button>
						</div>
					</div>
				</header>

				{/* Hero Section */}
				<section className="container mx-auto px-4 py-20 md:py-32">
					<div className="max-w-4xl mx-auto text-center">
						<div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-accent/10 border border-accent/20 mb-8">
							<span className="w-2 h-2 bg-accent rounded-full animate-pulse"></span>
							<span className="text-sm text-foreground">
								Built on AT Protocol
							</span>
						</div>

						<h1 className="text-5xl md:text-7xl font-bold text-balance mb-6 leading-tight">
							Your Website.Your Control. Lightning Fast.
						</h1>

						<p className="text-xl md:text-2xl text-muted-foreground text-balance mb-10 leading-relaxed max-w-3xl mx-auto">
							Host static sites in your AT Protocol account. You
							keep ownership and control. We just serve them fast
							through our CDN.
						</p>

						<div className="max-w-md mx-auto relative">
							<div
								className={`transition-all duration-500 ease-in-out ${
									showForm
										? 'opacity-0 -translate-y-5 pointer-events-none'
										: 'opacity-100 translate-y-0'
								}`}
							>
								<Button
									size="lg"
									className="bg-primary text-primary-foreground hover:bg-primary/90 text-lg px-8 py-6 w-full"
									onClick={() => setShowForm(true)}
								>
									Log in with AT Proto
									<ArrowRight className="ml-2 w-5 h-5" />
								</Button>
							</div>

							<div
								className={`transition-all duration-500 ease-in-out absolute inset-0 ${
									showForm
										? 'opacity-100 translate-y-0'
										: 'opacity-0 translate-y-5 pointer-events-none'
								}`}
							>
								<form
									onSubmit={async (e) => {
										e.preventDefault()
										try {
											const handle =
												inputRef.current?.value
											const res = await fetch(
												'/api/auth/signin',
												{
													method: 'POST',
													headers: {
														'Content-Type':
															'application/json'
													},
													body: JSON.stringify({
														handle
													})
												}
											)
											if (!res.ok)
												throw new Error(
													'Request failed'
												)
											const data = await res.json()
											if (data.url) {
												window.location.href = data.url
											} else {
												alert('Unexpected response')
											}
										} catch (error) {
											console.error(
												'Login failed:',
												error
											)
											alert('Authentication failed')
										}
									}}
									className="space-y-3"
								>
									<input
										ref={inputRef}
										type="text"
										name="handle"
										placeholder="Enter your handle (e.g., alice.bsky.social)"
										className="w-full py-4 px-4 text-lg bg-input border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
									/>
									<button
										type="submit"
										className="w-full bg-accent hover:bg-accent/90 text-accent-foreground font-semibold py-4 px-6 text-lg rounded-lg inline-flex items-center justify-center transition-colors"
									>
										Continue
										<ArrowRight className="ml-2 w-5 h-5" />
									</button>
								</form>
							</div>
						</div>
					</div>
				</section>

				{/* How It Works */}
				<section className="container mx-auto px-4 py-16 bg-muted/30">
					<div className="max-w-3xl mx-auto text-center">
						<h2 className="text-3xl md:text-4xl font-bold mb-8">
							How it works
						</h2>
						<div className="space-y-6 text-left">
							<div className="flex gap-4 items-start">
								<div className="text-4xl font-bold text-accent/40 min-w-[60px]">
									01
								</div>
								<div>
									<h3 className="text-xl font-semibold mb-2">
										Upload your static site
									</h3>
									<p className="text-muted-foreground">
										Your HTML, CSS, and JavaScript files are
										stored in your AT Protocol account as
										gzipped blobs and a manifest record.
									</p>
								</div>
							</div>
							<div className="flex gap-4 items-start">
								<div className="text-4xl font-bold text-accent/40 min-w-[60px]">
									02
								</div>
								<div>
									<h3 className="text-xl font-semibold mb-2">
										We serve it globally
									</h3>
									<p className="text-muted-foreground">
										Wisp.place reads your site from your
										account and delivers it through our CDN
										for fast loading anywhere.
									</p>
								</div>
							</div>
							<div className="flex gap-4 items-start">
								<div className="text-4xl font-bold text-accent/40 min-w-[60px]">
									03
								</div>
								<div>
									<h3 className="text-xl font-semibold mb-2">
										You stay in control
									</h3>
									<p className="text-muted-foreground">
										Update or remove your site anytime
										through your AT Protocol account. No
										lock-in, no middleman ownership.
									</p>
								</div>
							</div>
						</div>
					</div>
				</section>

				{/* Features Grid */}
				<section id="features" className="container mx-auto px-4 py-20">
					<div className="text-center mb-16">
						<h2 className="text-4xl md:text-5xl font-bold mb-4 text-balance">
							Why Wisp.place?
						</h2>
						<p className="text-xl text-muted-foreground text-balance max-w-2xl mx-auto">
							Static site hosting that respects your ownership
						</p>
					</div>

					<div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
						{[
							{
								icon: Shield,
								title: 'You Own Your Content',
								description:
									'Your site lives in your AT Protocol account. Move it to another service anytime, or take it offline yourself.'
							},
							{
								icon: Zap,
								title: 'CDN Performance',
								description:
									'We cache and serve your site from edge locations worldwide for fast load times.'
							},
							{
								icon: Lock,
								title: 'No Vendor Lock-in',
								description:
									'Your data stays in your account. Switch providers or self-host whenever you want.'
							},
							{
								icon: Code,
								title: 'Simple Deployment',
								description:
									'Upload your static files and we handle the rest. No complex configuration needed.'
							},
							{
								icon: Server,
								title: 'AT Protocol Native',
								description:
									'Built for the decentralized web. Your site has a verifiable identity on the network.'
							},
							{
								icon: Globe,
								title: 'Custom Domains',
								description:
									'Use your own domain name or a wisp.place subdomain. Your choice, either way.'
							}
						].map((feature, i) => (
							<Card
								key={i}
								className="p-6 hover:shadow-lg transition-shadow border-2 bg-card"
							>
								<div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center mb-4">
									<feature.icon className="w-6 h-6 text-accent" />
								</div>
								<h3 className="text-xl font-semibold mb-2 text-card-foreground">
									{feature.title}
								</h3>
								<p className="text-muted-foreground leading-relaxed">
									{feature.description}
								</p>
							</Card>
						))}
					</div>
				</section>

				{/* CTA Section */}
				<section className="container mx-auto px-4 py-20">
					<div className="max-w-6xl mx-auto">
						<div className="text-center mb-12">
							<h2 className="text-3xl md:text-4xl font-bold">
								Follow on Bluesky for updates
							</h2>
						</div>
						<div className="grid md:grid-cols-2 gap-8 items-center">
							<Card
								className="shadow-lg border-2 border-border overflow-hidden !py-3"
								style={{
									'--atproto-color-bg': 'var(--card)',
									'--atproto-color-bg-elevated': 'hsl(var(--muted) / 0.3)',
									'--atproto-color-text': 'hsl(var(--foreground))',
									'--atproto-color-text-secondary': 'hsl(var(--muted-foreground))',
									'--atproto-color-link': 'hsl(var(--accent))',
									'--atproto-color-link-hover': 'hsl(var(--accent))',
									'--atproto-color-border': 'transparent',
								} as AtProtoStyles}
							>
								<BlueskyPostList did="wisp.place" />
							</Card>
							<div className="space-y-6 w-full max-w-md mx-auto">
								<Card
									className="shadow-lg border-2 overflow-hidden relative !py-3"
									style={{
										'--atproto-color-bg': 'var(--card)',
										'--atproto-color-bg-elevated': 'hsl(var(--muted) / 0.3)',
										'--atproto-color-text': 'hsl(var(--foreground))',
										'--atproto-color-text-secondary': 'hsl(var(--muted-foreground))',
									} as AtProtoStyles}
								>
									<BlueskyProfile did="wisp.place" />
								</Card>
								<Card
									className="shadow-lg border-2 overflow-hidden relative !py-3"
									style={{
										'--atproto-color-bg': 'var(--card)',
										'--atproto-color-bg-elevated': 'hsl(var(--muted) / 0.3)',
										'--atproto-color-text': 'hsl(var(--foreground))',
										'--atproto-color-text-secondary': 'hsl(var(--muted-foreground))',
									} as AtProtoStyles}
								>
									<LatestPostWithPrefetch did="wisp.place" />
								</Card>
							</div>
						</div>
					</div>
				</section>

				{/* Ready to Deploy CTA */}
				<section className="container mx-auto px-4 py-20">
					<div className="max-w-3xl mx-auto text-center bg-accent/5 border border-accent/20 rounded-2xl p-12">
						<h2 className="text-3xl md:text-4xl font-bold mb-4">
							Ready to deploy?
						</h2>
						<p className="text-xl text-muted-foreground mb-8">
							Host your static site on your own AT Protocol
							account today
						</p>
						<Button
							size="lg"
							className="bg-accent text-accent-foreground hover:bg-accent/90 text-lg px-8 py-6"
							onClick={() => setShowForm(true)}
						>
							Get Started
							<ArrowRight className="ml-2 w-5 h-5" />
						</Button>
					</div>
				</section>

				{/* Footer */}
				<footer className="border-t border-border/40 bg-muted/20">
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
								<a
									href="/acceptable-use"
									className="text-accent hover:text-accent/80 transition-colors font-medium"
								>
									Acceptable Use Policy
								</a>
							</p>
						</div>
					</div>
				</footer>
			</div>
		</>
	)
}

const root = createRoot(document.getElementById('elysia')!)
root.render(
	<AtProtoProvider>
		<Layout className="gap-6">
			<App />
		</Layout>
	</AtProtoProvider>
)
