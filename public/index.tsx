import { useState, useRef, useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import Layout from '@public/layouts'

function App() {
	const [showForm, setShowForm] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (showForm) {
			setTimeout(() => inputRef.current?.focus(), 500)
		}
	}, [showForm])

	return (
		<>
			<section id="header" className="py-24 px-6">
				<div className="text-center space-y-8">
					<div className="space-y-4">
						<h1 className="text-6xl md:text-8xl font-bold text-balance leading-tight">
							The complete platform to{' '}
							<span className="gradient-text">
								publish the web.
							</span>
						</h1>
						<p className="text-xl md:text-2xl text-muted-foreground max-w-3xl mx-auto text-balance">
							Your decentralized toolkit to stop configuring and
							start publishing. Securely build, deploy, and own
							your web presence with AT Protocol.
						</p>
					</div>

					<div className="inline-flex items-center gap-2 bg-accent/10 border border-accent/20 rounded-full px-4 py-2">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							className="h-5 w-5 text-accent"
							viewBox="0 0 20 20"
							fill="currentColor"
						>
							<path
								fillRule="evenodd"
								d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.414-1.414L11 9.586V6z"
								clipRule="evenodd"
							/>
						</svg>
						<span className="text-sm font-medium text-accent">
							Publish once, own forever
						</span>
					</div>

					<div className="max-w-md mx-auto space-y-4 mt-8">
						<div className="relative h-16">
							<div
								className={`transition-all duration-500 ease-in-out absolute inset-0 ${
									showForm
										? 'opacity-0 -translate-y-5 pointer-events-none'
										: 'opacity-100 translate-y-0'
								}`}
							>
								<button
									onClick={() => setShowForm(true)}
									className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold py-4 px-6 text-lg rounded-lg inline-flex items-center justify-center transition-colors"
								>
									Log in with AT Proto
									<svg
										xmlns="http://www.w3.org/2000/svg"
										className="ml-2 w-5 h-5"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M5 12h14M12 5l7 7-7 7" />
									</svg>
								</button>
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
										<svg
											xmlns="http://www.w3.org/2000/svg"
											className="ml-2 w-5 h-5"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M5 12h14M12 5l7 7-7 7" />
										</svg>
									</button>
								</form>
							</div>
						</div>
					</div>
				</div>
			</section>
		</>
	)
}

const root = createRoot(document.getElementById('elysia')!)
root.render(
	<Layout className="gap-6">
		<App />
	</Layout>
)
