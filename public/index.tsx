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

function App() {
	const [showForm, setShowForm] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (showForm) {
			setTimeout(() => inputRef.current?.focus(), 500)
		}
	}, [showForm])

	return (
		<div className="min-h-screen">
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
						<span className="text-sm text-accent-foreground">
							Built on AT Protocol
						</span>
					</div>

					<h1 className="text-5xl md:text-7xl font-bold text-balance mb-6 leading-tight">
						Host your sites on the{' '}
						<span className="text-primary">decentralized</span> web
					</h1>

					<p className="text-xl md:text-2xl text-muted-foreground text-balance mb-10 leading-relaxed max-w-3xl mx-auto">
						Deploy static sites to a truly open network. Your
						content, your control, your identity. No platform
						lock-in, ever.
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
										const handle = inputRef.current?.value
										const res = await fetch(
											'/api/auth/signin',
											{
												method: 'POST',
												headers: {
													'Content-Type':
														'application/json'
												},
												body: JSON.stringify({ handle })
											}
										)
										if (!res.ok)
											throw new Error('Request failed')
										const data = await res.json()
										if (data.url) {
											window.location.href = data.url
										} else {
											alert('Unexpected response')
										}
									} catch (error) {
										console.error('Login failed:', error)
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

			{/* Stats Section */}
			<section className="container mx-auto px-4 py-16">
				<div className="grid grid-cols-2 md:grid-cols-4 gap-8 max-w-5xl mx-auto">
					{[
						{ value: '100%', label: 'Decentralized' },
						{ value: '0ms', label: 'Cold Start' },
						{ value: '∞', label: 'Scalability' },
						{ value: 'You', label: 'Own Your Data' }
					].map((stat, i) => (
						<div key={i} className="text-center">
							<div className="text-4xl md:text-5xl font-bold text-primary mb-2">
								{stat.value}
							</div>
							<div className="text-sm text-muted-foreground">
								{stat.label}
							</div>
						</div>
					))}
				</div>
			</section>

			{/* Features Grid */}
			<section id="features" className="container mx-auto px-4 py-20">
				<div className="text-center mb-16">
					<h2 className="text-4xl md:text-5xl font-bold mb-4 text-balance">
						Built for the open web
					</h2>
					<p className="text-xl text-muted-foreground text-balance max-w-2xl mx-auto">
						Everything you need to deploy and manage static sites on
						a decentralized network
					</p>
				</div>

				<div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
					{[
						{
							icon: Shield,
							title: 'True Ownership',
							description:
								'Your content lives on the AT Protocol network. No single company can take it down or lock you out.'
						},
						{
							icon: Zap,
							title: 'Lightning Fast',
							description:
								'Distributed edge network ensures your sites load instantly from anywhere in the world.'
						},
						{
							icon: Lock,
							title: 'Cryptographic Security',
							description:
								'Content-addressed storage and cryptographic verification ensure integrity and authenticity.'
						},
						{
							icon: Code,
							title: 'Developer Friendly',
							description:
								'Simple CLI, Git integration, and familiar workflows. Deploy with a single command.'
						},
						{
							icon: Server,
							title: 'Zero Vendor Lock-in',
							description:
								'Built on open protocols. Migrate your sites anywhere, anytime. Your data is portable.'
						},
						{
							icon: Globe,
							title: 'Global Network',
							description:
								'Leverage the power of decentralized infrastructure for unmatched reliability and uptime.'
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

			{/* How It Works */}
			<section
				id="how-it-works"
				className="container mx-auto px-4 py-20 bg-muted/30"
			>
				<div className="max-w-4xl mx-auto">
					<h2 className="text-4xl md:text-5xl font-bold text-center mb-16 text-balance">
						Deploy in three steps
					</h2>

					<div className="space-y-12">
						{[
							{
								step: '01',
								title: 'Upload your site',
								description:
									'Link your Git repository or upload a folder containing your static site directly.'
							},
							{
								step: '02',
								title: 'Name and set domain',
								description:
									'Name your site and set domain routing to it. You can bring your own domain too.'
							},
							{
								step: '03',
								title: 'Deploy to AT Protocol',
								description:
									'Your site is published to the decentralized network with a permanent, verifiable identity.'
							}
						].map((step, i) => (
							<div key={i} className="flex gap-6 items-start">
								<div className="text-6xl font-bold text-accent/20 min-w-[80px]">
									{step.step}
								</div>
								<div className="flex-1 pt-2">
									<h3 className="text-2xl font-semibold mb-3">
										{step.title}
									</h3>
									<p className="text-lg text-muted-foreground leading-relaxed">
										{step.description}
									</p>
								</div>
							</div>
						))}
					</div>
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
						</p>
					</div>
				</div>
			</footer>
		</div>
	)
}

const root = createRoot(document.getElementById('elysia')!)
root.render(
	<Layout className="gap-6">
		<App />
	</Layout>
)
