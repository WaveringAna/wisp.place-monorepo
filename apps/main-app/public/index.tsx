import React, { useState, useRef, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowRight } from 'lucide-react'
import Layout from '@public/layouts'
import { Button } from '@public/components/ui/button'
import { Card } from '@public/components/ui/card'
import { BlueskyPostList, BlueskyProfile, BlueskyPost, AtProtoProvider, useLatestRecord, type AtProtoStyles, type FeedPostRecord } from 'atproto-ui'

//Credit to https://tangled.org/@jakelazaroff.com/actor-typeahead
interface Actor {
	handle: string
	avatar?: string
	displayName?: string
}

interface ActorTypeaheadProps {
	children: React.ReactElement<React.InputHTMLAttributes<HTMLInputElement>>
	host?: string
	rows?: number
	onSelect?: (handle: string) => void
	autoSubmit?: boolean
}

const ActorTypeahead: React.FC<ActorTypeaheadProps> = ({
	children,
	host = 'https://public.api.bsky.app',
	rows = 5,
	onSelect,
	autoSubmit = false
}) => {
	const [actors, setActors] = useState<Actor[]>([])
	const [index, setIndex] = useState(-1)
	const [pressed, setPressed] = useState(false)
	const [isOpen, setIsOpen] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const lastQueryRef = useRef<string>('')
	const previousValueRef = useRef<string>('')
	const preserveIndexRef = useRef(false)

	const handleInput = async (e: React.FormEvent<HTMLInputElement>) => {
		const query = e.currentTarget.value

		// Check if the value actually changed (filter out arrow key events)
		if (query === previousValueRef.current) {
			return
		}
		previousValueRef.current = query

		if (!query) {
			setActors([])
			setIndex(-1)
			setIsOpen(false)
			lastQueryRef.current = ''
			return
		}

		// Store the query for this request
		const currentQuery = query
		lastQueryRef.current = currentQuery

		try {
			const url = new URL('xrpc/app.bsky.actor.searchActorsTypeahead', host)
			url.searchParams.set('q', query)
			url.searchParams.set('limit', `${rows}`)

			const res = await fetch(url)
			const json = await res.json()

			// Only update if this is still the latest query
			if (lastQueryRef.current === currentQuery) {
				setActors(json.actors || [])
				// Only reset index if we're not preserving it
				if (!preserveIndexRef.current) {
					setIndex(-1)
				}
				preserveIndexRef.current = false
				setIsOpen(true)
			}
		} catch (error) {
			console.error('Failed to fetch actors:', error)
			if (lastQueryRef.current === currentQuery) {
				setActors([])
				setIsOpen(false)
			}
		}
	}

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		const navigationKeys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Enter', 'Escape']
		
		// Mark that we should preserve the index for navigation keys
		if (navigationKeys.includes(e.key)) {
			preserveIndexRef.current = true
		}

		if (!isOpen || actors.length === 0) return

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault()
				setIndex((prev) => {
					const newIndex = prev < 0 ? 0 : Math.min(prev + 1, actors.length - 1)
					return newIndex
				})
				break
			case 'PageDown':
				e.preventDefault()
				setIndex(actors.length - 1)
				break
			case 'ArrowUp':
				e.preventDefault()
				setIndex((prev) => {
					const newIndex = prev < 0 ? 0 : Math.max(prev - 1, 0)
					return newIndex
				})
				break
			case 'PageUp':
				e.preventDefault()
				setIndex(0)
				break
			case 'Escape':
				e.preventDefault()
				setActors([])
				setIndex(-1)
				setIsOpen(false)
				break
			case 'Enter':
				if (index >= 0 && index < actors.length) {
					e.preventDefault()
					selectActor(actors[index].handle)
				}
				break
		}
	}

	const selectActor = (handle: string) => {
		if (inputRef.current) {
			inputRef.current.value = handle
		}
		setActors([])
		setIndex(-1)
		setIsOpen(false)
		onSelect?.(handle)
		
		// Auto-submit the form if enabled
		if (autoSubmit && inputRef.current) {
			const form = inputRef.current.closest('form')
			if (form) {
				// Use setTimeout to ensure the value is set before submission
				setTimeout(() => {
					form.requestSubmit()
				}, 0)
			}
		}
	}

	const handleFocusOut = (e: React.FocusEvent) => {
		if (pressed) return
		setActors([])
		setIndex(-1)
		setIsOpen(false)
	}

	// Clone the input element and add our event handlers
	const input = React.cloneElement(children, {
		ref: (el: HTMLInputElement) => {
			inputRef.current = el
			// Preserve the original ref if it exists
			const originalRef = (children as any).ref
			if (typeof originalRef === 'function') {
				originalRef(el)
			} else if (originalRef) {
				originalRef.current = el
			}
		},
		onInput: (e: React.FormEvent<HTMLInputElement>) => {
			handleInput(e)
			children.props.onInput?.(e)
		},
		onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
			handleKeyDown(e)
			children.props.onKeyDown?.(e)
		},
		onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
			handleFocusOut(e)
			children.props.onBlur?.(e)
		},
		autoComplete: 'off'
	} as any)

	return (
		<div ref={containerRef} style={{ position: 'relative', display: 'block' }}>
			{input}
			{isOpen && actors.length > 0 && (
				<ul
					style={{
						display: 'flex',
						flexDirection: 'column',
						position: 'absolute',
						left: 0,
						marginTop: '4px',
						width: '100%',
						listStyle: 'none',
						overflow: 'hidden',
						backgroundColor: 'rgba(255, 255, 255, 0.8)',
						backgroundClip: 'padding-box',
						backdropFilter: 'blur(12px)',
						WebkitBackdropFilter: 'blur(12px)',
						border: '1px solid rgba(0, 0, 0, 0.1)',
						borderRadius: '8px',
						boxShadow: '0 6px 6px -4px rgba(0, 0, 0, 0.2)',
						padding: '4px',
						margin: 0,
						zIndex: 1000
					}}
					onMouseDown={() => setPressed(true)}
					onMouseUp={() => {
						setPressed(false)
						inputRef.current?.focus()
					}}
				>
					{actors.map((actor, i) => (
						<li key={actor.handle}>
							<button
								type="button"
								onClick={() => selectActor(actor.handle)}
								style={{
									all: 'unset',
									boxSizing: 'border-box',
									display: 'flex',
									alignItems: 'center',
									gap: '8px',
									padding: '6px 8px',
									width: '100%',
									height: 'calc(1.5rem + 12px)',
									borderRadius: '4px',
									cursor: 'pointer',
									backgroundColor: i === index ? 'hsl(var(--accent) / 0.5)' : 'transparent',
									transition: 'background-color 0.1s'
								}}
								onMouseEnter={() => setIndex(i)}
							>
								<div
									style={{
										width: '1.5rem',
										height: '1.5rem',
										borderRadius: '50%',
										backgroundColor: 'hsl(var(--muted))',
										overflow: 'hidden',
										flexShrink: 0
									}}
								>
									{actor.avatar && (
										<img
											src={actor.avatar}
											alt=""
											style={{
												display: 'block',
												width: '100%',
												height: '100%',
												objectFit: 'cover'
											}}
										/>
									)}
								</div>
								<span
									style={{
										whiteSpace: 'nowrap',
										overflow: 'hidden',
										textOverflow: 'ellipsis',
										color: '#000000'
									}}
								>
									{actor.handle}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	)
}

const LatestPostWithPrefetch: React.FC<{ did: string }> = ({ did }) => {
	const { record, rkey, loading } = useLatestRecord<FeedPostRecord>(
		did,
		'app.bsky.feed.post'
	)

	if (loading) return <span>Loading…</span>
	if (!record || !rkey) return <span>No posts yet.</span>

	return <BlueskyPost did={did} rkey={rkey} record={record} showParent={true} />
}

function App() {
	const [showForm, setShowForm] = useState(false)
	const [checkingAuth, setCheckingAuth] = useState(true)
	const [screenshots, setScreenshots] = useState<string[]>([])
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
				// If not authenticated, clear any stale cookies
				document.cookie = 'did=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'
			} catch (error) {
				console.error('Auth check failed:', error)
				// Clear cookies on error as well
				document.cookie = 'did=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'
			} finally {
				setCheckingAuth(false)
			}
		}

		checkAuth()
	}, [])

	useEffect(() => {
		// Fetch screenshots list
		const fetchScreenshots = async () => {
			try {
				const response = await fetch('/api/screenshots')
				const data = await response.json()
				setScreenshots(data.screenshots || [])
			} catch (error) {
				console.error('Failed to fetch screenshots:', error)
			}
		}

		fetchScreenshots()
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
								asChild
							>
								<a href="https://docs.wisp.place" target="_blank" rel="noopener noreferrer">
									Read the Docs
								</a>
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
											// Clear any invalid cookies
											document.cookie = 'did=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'
											alert('Authentication failed')
										}
									}}
									className="space-y-3"
								>
									<ActorTypeahead
										autoSubmit={true}
										onSelect={(handle) => {
											if (inputRef.current) {
												inputRef.current.value = handle
											}
										}}
									>
										<input
											ref={inputRef}
											type="text"
											name="handle"
											placeholder="Enter your handle (e.g., alice.bsky.social)"
											className="w-full py-4 px-4 text-lg bg-input border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
										/>
									</ActorTypeahead>
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

				{/* Site Gallery */}
				<section id="gallery" className="container mx-auto px-4 py-20">
					<div className="text-center mb-16">
						<h2 className="text-4xl md:text-5xl font-bold mb-4 text-balance">
							Join 80+ sites just like yours:
						</h2>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-5xl mx-auto">
						{screenshots.map((filename, i) => {
							// Remove .png extension
							const baseName = filename.replace('.png', '')

							// Construct site URL from filename
							let siteUrl: string
							if (baseName.startsWith('sites_wisp_place_did_plc_')) {
								// Handle format: sites_wisp_place_did_plc_{identifier}_{sitename}
								const match = baseName.match(/^sites_wisp_place_did_plc_([a-z0-9]+)_(.+)$/)
								if (match) {
									const [, identifier, sitename] = match
									siteUrl = `https://sites.wisp.place/did:plc:${identifier}/${sitename}`
								} else {
									siteUrl = '#'
								}
							} else {
								// Handle format: domain_tld or subdomain_domain_tld
								// Replace underscores with dots
								siteUrl = `https://${baseName.replace(/_/g, '.')}`
							}

							return (
								<a
									key={i}
									href={siteUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="block"
								>
									<Card className="overflow-hidden hover:shadow-xl transition-all hover:scale-105 border-2 bg-card p-0 cursor-pointer">
										<img
											src={`/screenshots/${filename}`}
											alt={`${baseName} screenshot`}
											className="w-full h-auto object-cover aspect-video"
											loading="lazy"
										/>
									</Card>
								</a>
							)
						})}
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
								{' • '}
								<a
									href="https://docs.wisp.place"
									target="_blank"
									rel="noopener noreferrer"
									className="text-accent hover:text-accent/80 transition-colors font-medium"
								>
									Documentation
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
