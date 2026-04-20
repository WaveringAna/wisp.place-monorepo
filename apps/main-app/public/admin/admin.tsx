import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

// Helper function to format Unix timestamp from database
function formatDbDate(timestamp: number | string): Date {
	const num = typeof timestamp === 'string' ? parseFloat(timestamp) : timestamp
	return new Date(num * 1000) // Convert seconds to milliseconds
}

// Login Component
function Login({ onLogin }: { onLogin: () => void }) {
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		setError('')
		setLoading(true)

		try {
			const res = await fetch('/api/admin/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, password }),
				credentials: 'include',
			})

			if (res.ok) {
				onLogin()
			} else {
				setError('Invalid credentials')
			}
		} catch (_err) {
			setError('Failed to login')
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
			<div className="w-full max-w-md">
				<div className="bg-gray-900 border border-gray-800 rounded-lg p-8 shadow-xl">
					<h1 className="text-2xl font-bold text-white mb-6">Admin Login</h1>
					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<label className="block text-sm font-medium text-gray-300 mb-2">Username</label>
							<input
								type="text"
								value={username}
								onChange={(e) => setUsername(e.target.value)}
								className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
								required
							/>
						</div>
						<div>
							<label className="block text-sm font-medium text-gray-300 mb-2">Password</label>
							<input
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
								required
							/>
						</div>
						{error && <div className="text-red-400 text-sm">{error}</div>}
						<button
							type="submit"
							disabled={loading}
							className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white font-medium py-2 px-4 rounded transition-colors"
						>
							{loading ? 'Logging in...' : 'Login'}
						</button>
					</form>
				</div>
			</div>
		</div>
	)
}

// Dashboard Component
function Dashboard() {
	const [tab, setTab] = useState('overview')
	const [database, setDatabase] = useState<any>(null)
	const [sites, setSites] = useState<any>(null)
	const [health, setHealth] = useState<any>(null)
	const [firehose, setFirehose] = useState<any>(null)
	const [supporters, setSupporters] = useState<any[]>([])
	const [autoRefresh, setAutoRefresh] = useState(true)

	// Supporter management
	const [newSupporterIdentifier, setNewSupporterIdentifier] = useState('')
	const [supporterLoading, setSupporterLoading] = useState(false)
	const [supporterError, setSupporterError] = useState('')
	const [supporterSuccess, setSupporterSuccess] = useState('')
	const [actorSearchResults, setActorSearchResults] = useState<any[]>([])
	const [showActorDropdown, setShowActorDropdown] = useState(false)
	const [searchLoading, setSearchLoading] = useState(false)

	const fetchDatabase = async () => {
		const res = await fetch('/api/admin/database', { credentials: 'include' })
		if (res.ok) {
			const data = await res.json()
			setDatabase(data)
		}
	}

	const fetchSites = async () => {
		const res = await fetch('/api/admin/sites', { credentials: 'include' })
		if (res.ok) {
			const data = await res.json()
			setSites(data)
		}
	}

	const fetchHealth = async () => {
		const res = await fetch('/api/admin/health', { credentials: 'include' })
		if (res.ok) {
			const data = await res.json()
			setHealth(data)
		}
	}

	const fetchFirehose = async () => {
		const res = await fetch('/api/admin/firehose', { credentials: 'include' })
		if (res.ok) {
			const data = await res.json()
			setFirehose(data)
		}
	}

	const fetchSupporters = async () => {
		const res = await fetch('/api/admin/supporters', { credentials: 'include' })
		if (res.ok) {
			const data = await res.json()
			const supportersWithHandles = await Promise.all(
				data.supporters.map(async (supporter: any) => {
					try {
						const profileRes = await fetch(
							`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${supporter.did}`,
						)
						if (profileRes.ok) {
							const profile = await profileRes.json()
							return { ...supporter, handle: profile.handle }
						}
					} catch (_err) {
						// Failed to fetch handle, just use DID
					}
					return { ...supporter, handle: null }
				}),
			)
			setSupporters(supportersWithHandles)
		}
	}

	const searchActors = async (query: string) => {
		if (query.trim().length < 2) {
			setActorSearchResults([])
			setShowActorDropdown(false)
			return
		}

		setSearchLoading(true)
		try {
			const url = new URL('https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead')
			url.searchParams.set('q', query.trim())
			url.searchParams.set('limit', '10')

			const response = await fetch(url.toString(), {
				headers: {
					Accept: 'application/json',
				},
			})

			if (response.ok) {
				const data = await response.json()
				setActorSearchResults(data.actors || [])
				setShowActorDropdown(true)
			}
		} catch (err) {
			console.error('Failed to search actors:', err)
		} finally {
			setSearchLoading(false)
		}
	}

	// Debounced search effect
	useEffect(() => {
		if (!newSupporterIdentifier.trim()) {
			setActorSearchResults([])
			setShowActorDropdown(false)
			return
		}

		if (newSupporterIdentifier.startsWith('did:')) {
			setShowActorDropdown(false)
			return
		}

		const timeoutId = setTimeout(() => {
			searchActors(newSupporterIdentifier)
		}, 300)

		return () => clearTimeout(timeoutId)
	}, [newSupporterIdentifier])

	const selectActor = (actor: any) => {
		setNewSupporterIdentifier(actor.handle)
		setShowActorDropdown(false)
		setActorSearchResults([])
	}

	const addNewSupporter = async (e: React.FormEvent) => {
		e.preventDefault()
		setSupporterError('')
		setSupporterSuccess('')
		setSupporterLoading(true)

		try {
			const res = await fetch('/api/admin/supporters', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifier: newSupporterIdentifier }),
				credentials: 'include',
			})

			if (res.ok) {
				const data = await res.json()
				setSupporterSuccess(`Added supporter: ${data.did}`)
				setNewSupporterIdentifier('')
				await fetchSupporters()
			} else {
				const error = await res.json()
				setSupporterError(error.message || 'Failed to add supporter')
			}
		} catch (_err) {
			setSupporterError('Failed to add supporter')
		} finally {
			setSupporterLoading(false)
		}
	}

	const removeSupporter = async (did: string) => {
		if (!confirm(`Remove supporter ${did}?`)) return

		try {
			const res = await fetch(`/api/admin/supporters/${encodeURIComponent(did)}`, {
				method: 'DELETE',
				credentials: 'include',
			})

			if (res.ok) {
				await fetchSupporters()
			}
		} catch (_err) {
			alert('Failed to remove supporter')
		}
	}

	const logout = async () => {
		await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' })
		window.location.reload()
	}

	useEffect(() => {
		fetchDatabase()
		fetchHealth()
		fetchFirehose()
		fetchSites()
		fetchSupporters()
	}, [fetchDatabase, fetchFirehose, fetchHealth, fetchSites, fetchSupporters])

	useEffect(() => {
		if (!autoRefresh) return

		const interval = setInterval(() => {
			if (tab === 'overview') {
				fetchHealth()
				fetchFirehose()
			} else if (tab === 'database') {
				fetchDatabase()
			} else if (tab === 'sites') {
				fetchSites()
			} else if (tab === 'supporters') {
				fetchSupporters()
			}
		}, 5000)

		return () => clearInterval(interval)
	}, [tab, autoRefresh, fetchDatabase, fetchFirehose, fetchHealth, fetchSites, fetchSupporters])

	const formatUptime = (seconds: number) => {
		const hours = Math.floor(seconds / 3600)
		const minutes = Math.floor((seconds % 3600) / 60)
		return `${hours}h ${minutes}m`
	}

	return (
		<div className="min-h-screen bg-gray-950 text-white">
			{/* Header */}
			<div className="bg-gray-900 border-b border-gray-800 px-6 py-4">
				<div className="flex items-center justify-between">
					<h1 className="text-2xl font-bold">Wisp.place Admin</h1>
					<div className="flex items-center gap-4">
						<label className="flex items-center gap-2 text-sm text-gray-400">
							<input
								type="checkbox"
								checked={autoRefresh}
								onChange={(e) => setAutoRefresh(e.target.checked)}
								className="rounded"
							/>
							Auto-refresh
						</label>
						<button onClick={logout} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm">
							Logout
						</button>
					</div>
				</div>
			</div>

			{/* Tabs */}
			<div className="bg-gray-900 border-b border-gray-800 px-6">
				<div className="flex gap-1">
					{['overview', 'database', 'sites', 'supporters'].map((t) => (
						<button
							key={t}
							onClick={() => setTab(t)}
							className={`px-4 py-3 text-sm font-medium capitalize transition-colors ${
								tab === t ? 'text-white border-b-2 border-blue-500' : 'text-gray-400 hover:text-white'
							}`}
						>
							{t}
						</button>
					))}
				</div>
			</div>

			{/* Content */}
			<div className="p-6">
				{tab === 'overview' && (
					<div className="space-y-6">
						{/* Health */}
						{health && (
							<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
								<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
									<div className="text-sm text-gray-400 mb-1">Uptime</div>
									<div className="text-2xl font-bold">{formatUptime(health.uptime)}</div>
								</div>
								<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
									<div className="text-sm text-gray-400 mb-1">Memory Used</div>
									<div className="text-2xl font-bold">{health.memory.heapUsed} MB</div>
								</div>
								<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
									<div className="text-sm text-gray-400 mb-1">RSS</div>
									<div className="text-2xl font-bold">{health.memory.rss} MB</div>
								</div>
							</div>
						)}

						{/* Firehose Worker */}
						{firehose && (
							<div>
								<h2 className="text-xl font-bold mb-4">Firehose Worker</h2>
								<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
									<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
										<div>
											<div className="text-sm text-gray-400">Status</div>
											<div className="flex items-center gap-2 mt-1">
												<span
													className={`inline-block w-3 h-3 rounded-full ${firehose.firehose?.healthy ? 'bg-green-500' : 'bg-red-500'}`}
												></span>
												<span className="text-lg font-bold">
													{firehose.firehose?.connected ? 'Connected' : 'Disconnected'}
												</span>
											</div>
										</div>
										<div>
											<div className="text-sm text-gray-400">Mode</div>
											<div className="text-lg font-bold capitalize">{firehose.mode || 'unknown'}</div>
										</div>
										<div>
											<div className="text-sm text-gray-400">Queue Size</div>
											<div className="text-lg font-bold">{firehose.firehose?.queueSize || 0}</div>
										</div>
										<div>
											<div className="text-sm text-gray-400">Active Handlers</div>
											<div className="text-lg font-bold">{firehose.firehose?.activeHandlers || 0}</div>
										</div>
									</div>
									{firehose.firehose?.lastEventTime && (
										<div className="mt-3 text-sm text-gray-400">
											Last event: {new Date(firehose.firehose.lastEventTime).toLocaleString()}(
											{Math.round(firehose.firehose.timeSinceLastEvent / 1000)}s ago)
										</div>
									)}
								</div>
							</div>
						)}
					</div>
				)}

				{tab === 'database' && database && (
					<div className="space-y-6">
						{/* Stats */}
						<div className="grid grid-cols-2 md:grid-cols-5 gap-4">
							<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
								<div className="text-sm text-gray-400 mb-1">Total Sites</div>
								<div className="text-3xl font-bold">{database.stats.totalSites}</div>
							</div>
							<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
								<div className="text-sm text-gray-400 mb-1">Wisp Subdomains</div>
								<div className="text-3xl font-bold">{database.stats.totalWispSubdomains}</div>
							</div>
							<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
								<div className="text-sm text-gray-400 mb-1">Custom Domains</div>
								<div className="text-3xl font-bold">{database.stats.totalCustomDomains}</div>
							</div>
							<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
								<div className="text-sm text-gray-400 mb-1">Site Cache</div>
								<div className="text-3xl font-bold">{database.stats.totalSiteCache}</div>
							</div>
							<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
								<div className="text-sm text-gray-400 mb-1">Settings Cache</div>
								<div className="text-3xl font-bold">{database.stats.totalSiteSettingsCache}</div>
							</div>
						</div>

						{/* Recent Sites */}
						<div>
							<h3 className="text-lg font-semibold mb-3">Recent Sites</h3>
							<div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
								<table className="w-full text-sm">
									<thead className="bg-gray-800">
										<tr>
											<th className="px-4 py-2 text-left">Site Name</th>
											<th className="px-4 py-2 text-left">Links</th>
											<th className="px-4 py-2 text-left">DID</th>
											<th className="px-4 py-2 text-left">RKey</th>
											<th className="px-4 py-2 text-left">Created</th>
											<th className="px-4 py-2 text-left">PDSls</th>
										</tr>
									</thead>
									<tbody>
										{database.recentSites.map((site: any, i: number) => (
											<tr key={i} className="border-t border-gray-800">
												<td className="px-4 py-2">{site.display_name || 'Untitled'}</td>
												<td className="px-4 py-2">
													<div className="flex flex-col gap-1">
														<a
															href={`https://sites.wisp.place/${site.did}/${site.rkey || 'self'}`}
															target="_blank"
															rel="noopener noreferrer"
															className="text-blue-400 hover:underline text-xs"
														>
															sites.wisp.place
														</a>
														{site.subdomain && (
															<a
																href={`https://${site.subdomain}`}
																target="_blank"
																rel="noopener noreferrer"
																className="text-green-400 hover:underline text-xs"
															>
																{site.subdomain}
															</a>
														)}
														{site.custom_domain && (
															<a
																href={`https://${site.custom_domain}`}
																target="_blank"
																rel="noopener noreferrer"
																className="text-purple-400 hover:underline text-xs"
															>
																{site.custom_domain}
															</a>
														)}
													</div>
												</td>
												<td className="px-4 py-2 text-gray-400 font-mono text-xs">{site.did}</td>
												<td className="px-4 py-2 text-gray-400">{site.rkey || 'self'}</td>
												<td className="px-4 py-2 text-gray-400">
													{formatDbDate(site.created_at).toLocaleDateString()}
												</td>
												<td className="px-4 py-2">
													<a
														href={`https://pdsls.dev/at://${site.did}/place.wisp.fs/${site.rkey || 'self'}`}
														target="_blank"
														rel="noopener noreferrer"
														className="text-blue-400 hover:text-blue-300 transition-colors"
														title="View on PDSls.dev"
													>
														<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
															<path
																strokeLinecap="round"
																strokeLinejoin="round"
																strokeWidth={2}
																d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
															/>
														</svg>
													</a>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>

						{/* Recent Domains */}
						<div>
							<h3 className="text-lg font-semibold mb-3">Recent Custom Domains</h3>
							<div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
								<table className="w-full text-sm">
									<thead className="bg-gray-800">
										<tr>
											<th className="px-4 py-2 text-left">Domain</th>
											<th className="px-4 py-2 text-left">DID</th>
											<th className="px-4 py-2 text-left">RKey</th>
											<th className="px-4 py-2 text-left">Verified</th>
											<th className="px-4 py-2 text-left">Created</th>
										</tr>
									</thead>
									<tbody>
										{database.recentDomains.map((domain: any, i: number) => (
											<tr key={i} className="border-t border-gray-800">
												<td className="px-4 py-2">
													{domain.verified ? (
														<a
															href={`https://${domain.domain}`}
															target="_blank"
															rel="noopener noreferrer"
															className="text-blue-400 hover:underline"
														>
															{domain.domain}
														</a>
													) : (
														<span className="text-gray-400">{domain.domain}</span>
													)}
												</td>
												<td className="px-4 py-2 text-gray-400 font-mono text-xs">{domain.did}</td>
												<td className="px-4 py-2 text-gray-400">{domain.rkey || 'self'}</td>
												<td className="px-4 py-2">
													<span
														className={`px-2 py-1 rounded text-xs ${
															domain.verified ? 'bg-green-900 text-green-200' : 'bg-yellow-900 text-yellow-200'
														}`}
													>
														{domain.verified ? 'Yes' : 'No'}
													</span>
												</td>
												<td className="px-4 py-2 text-gray-400">
													{formatDbDate(domain.created_at).toLocaleDateString()}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					</div>
				)}

				{tab === 'sites' && sites && (
					<div className="space-y-6">
						{/* All Sites */}
						<div>
							<h3 className="text-lg font-semibold mb-3">All Sites</h3>
							<div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
								<table className="w-full text-sm">
									<thead className="bg-gray-800">
										<tr>
											<th className="px-4 py-2 text-left">Site Name</th>
											<th className="px-4 py-2 text-left">Links</th>
											<th className="px-4 py-2 text-left">DID</th>
											<th className="px-4 py-2 text-left">RKey</th>
											<th className="px-4 py-2 text-left">Created</th>
											<th className="px-4 py-2 text-left">PDSls</th>
										</tr>
									</thead>
									<tbody>
										{sites.sites.map((site: any, i: number) => (
											<tr key={i} className="border-t border-gray-800 hover:bg-gray-800">
												<td className="px-4 py-2">{site.display_name || 'Untitled'}</td>
												<td className="px-4 py-2">
													<div className="flex flex-col gap-1">
														<a
															href={`https://sites.wisp.place/${site.did}/${site.rkey || 'self'}`}
															target="_blank"
															rel="noopener noreferrer"
															className="text-blue-400 hover:underline text-xs"
														>
															sites.wisp.place
														</a>
														{site.subdomain && (
															<a
																href={`https://${site.subdomain}`}
																target="_blank"
																rel="noopener noreferrer"
																className="text-green-400 hover:underline text-xs"
															>
																{site.subdomain}
															</a>
														)}
														{site.custom_domain && (
															<a
																href={`https://${site.custom_domain}`}
																target="_blank"
																rel="noopener noreferrer"
																className="text-purple-400 hover:underline text-xs"
															>
																{site.custom_domain}
															</a>
														)}
													</div>
												</td>
												<td className="px-4 py-2 text-gray-400 font-mono text-xs">{site.did}</td>
												<td className="px-4 py-2 text-gray-400">{site.rkey || 'self'}</td>
												<td className="px-4 py-2 text-gray-400">{formatDbDate(site.created_at).toLocaleString()}</td>
												<td className="px-4 py-2">
													<a
														href={`https://pdsls.dev/at://${site.did}/place.wisp.fs/${site.rkey || 'self'}`}
														target="_blank"
														rel="noopener noreferrer"
														className="text-blue-400 hover:text-blue-300 transition-colors"
														title="View on PDSls.dev"
													>
														<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
															<path
																strokeLinecap="round"
																strokeLinejoin="round"
																strokeWidth={2}
																d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
															/>
														</svg>
													</a>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>

						{/* Custom Domains */}
						<div>
							<h3 className="text-lg font-semibold mb-3">Custom Domains</h3>
							<div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
								<table className="w-full text-sm">
									<thead className="bg-gray-800">
										<tr>
											<th className="px-4 py-2 text-left">Domain</th>
											<th className="px-4 py-2 text-left">Verified</th>
											<th className="px-4 py-2 text-left">DID</th>
											<th className="px-4 py-2 text-left">RKey</th>
											<th className="px-4 py-2 text-left">Created</th>
											<th className="px-4 py-2 text-left">PDSls</th>
										</tr>
									</thead>
									<tbody>
										{sites.customDomains.map((domain: any, i: number) => (
											<tr key={i} className="border-t border-gray-800 hover:bg-gray-800">
												<td className="px-4 py-2">
													{domain.verified ? (
														<a
															href={`https://${domain.domain}`}
															target="_blank"
															rel="noopener noreferrer"
															className="text-blue-400 hover:underline"
														>
															{domain.domain}
														</a>
													) : (
														<span className="text-gray-400">{domain.domain}</span>
													)}
												</td>
												<td className="px-4 py-2">
													<span
														className={`px-2 py-1 rounded text-xs ${
															domain.verified ? 'bg-green-900 text-green-200' : 'bg-yellow-900 text-yellow-200'
														}`}
													>
														{domain.verified ? 'Yes' : 'Pending'}
													</span>
												</td>
												<td className="px-4 py-2 text-gray-400 font-mono text-xs">{domain.did}</td>
												<td className="px-4 py-2 text-gray-400">{domain.rkey || 'self'}</td>
												<td className="px-4 py-2 text-gray-400">{formatDbDate(domain.created_at).toLocaleString()}</td>
												<td className="px-4 py-2">
													<a
														href={`https://pdsls.dev/at://${domain.did}/place.wisp.fs/${domain.rkey || 'self'}`}
														target="_blank"
														rel="noopener noreferrer"
														className="text-blue-400 hover:text-blue-300 transition-colors"
														title="View on PDSls.dev"
													>
														<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
															<path
																strokeLinecap="round"
																strokeLinejoin="round"
																strokeWidth={2}
																d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
															/>
														</svg>
													</a>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					</div>
				)}

				{tab === 'supporters' && (
					<div className="space-y-6">
						{/* Add Supporter Form */}
						<div className="bg-gray-900 border border-gray-800 rounded-lg p-6">
							<h3 className="text-lg font-semibold mb-4">Add Supporter</h3>
							<form onSubmit={addNewSupporter} className="space-y-4">
								<div className="relative">
									<label className="block text-sm font-medium text-gray-300 mb-2">Bluesky Handle or DID</label>
									<input
										type="text"
										value={newSupporterIdentifier}
										onChange={(e) => {
											setNewSupporterIdentifier(e.target.value)
											setSupporterError('')
											setSupporterSuccess('')
										}}
										onFocus={() => {
											if (actorSearchResults.length > 0) {
												setShowActorDropdown(true)
											}
										}}
										onBlur={() => {
											// Delay to allow clicking on results
											setTimeout(() => setShowActorDropdown(false), 200)
										}}
										placeholder="Search for a user or enter did:plc:..."
										className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
										required
										autoComplete="off"
									/>
									{searchLoading && (
										<div className="absolute right-3 top-9 text-gray-500">
											<svg
												className="animate-spin h-4 w-4"
												xmlns="http://www.w3.org/2000/svg"
												fill="none"
												viewBox="0 0 24 24"
											>
												<circle
													className="opacity-25"
													cx="12"
													cy="12"
													r="10"
													stroke="currentColor"
													strokeWidth="4"
												></circle>
												<path
													className="opacity-75"
													fill="currentColor"
													d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
												></path>
											</svg>
										</div>
									)}
									{showActorDropdown && actorSearchResults.length > 0 && (
										<div className="absolute z-10 w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl max-h-64 overflow-y-auto">
											{actorSearchResults.map((actor) => (
												<button
													key={actor.did}
													type="button"
													onClick={() => selectActor(actor)}
													className="w-full px-4 py-3 hover:bg-gray-700 flex items-start gap-3 text-left transition-colors"
												>
													{actor.avatar && (
														<img
															src={actor.avatar}
															alt={actor.displayName || actor.handle}
															className="w-10 h-10 rounded-full flex-shrink-0"
														/>
													)}
													<div className="flex-1 min-w-0">
														<div className="font-medium text-white truncate">{actor.displayName || actor.handle}</div>
														<div className="text-sm text-gray-400 truncate">@{actor.handle}</div>
														{actor.description && (
															<div className="text-xs text-gray-500 truncate mt-1">{actor.description}</div>
														)}
													</div>
												</button>
											))}
										</div>
									)}
									<p className="text-xs text-gray-500 mt-1">
										Start typing to search for users, or enter a DID directly
									</p>
								</div>
								{supporterError && <div className="text-red-400 text-sm">{supporterError}</div>}
								{supporterSuccess && <div className="text-green-400 text-sm">{supporterSuccess}</div>}
								<button
									type="submit"
									disabled={supporterLoading}
									className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white font-medium rounded transition-colors"
								>
									{supporterLoading ? 'Adding...' : 'Add Supporter'}
								</button>
							</form>
						</div>

						{/* Supporters List */}
						<div>
							<h3 className="text-lg font-semibold mb-3">Current Supporters ({supporters.length})</h3>
							<div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
								<table className="w-full text-sm">
									<thead className="bg-gray-800">
										<tr>
											<th className="px-4 py-2 text-left">Handle</th>
											<th className="px-4 py-2 text-left">DID</th>
											<th className="px-4 py-2 text-left">Added</th>
											<th className="px-4 py-2 text-left">Actions</th>
										</tr>
									</thead>
									<tbody>
										{supporters.map((supporter: any) => (
											<tr key={supporter.did} className="border-t border-gray-800 hover:bg-gray-800">
												<td className="px-4 py-2">
													{supporter.handle ? (
														<a
															href={`https://bsky.app/profile/${supporter.handle}`}
															target="_blank"
															rel="noopener noreferrer"
															className="text-blue-400 hover:underline"
														>
															@{supporter.handle}
														</a>
													) : (
														<span className="text-gray-500 italic">Loading...</span>
													)}
												</td>
												<td className="px-4 py-2 font-mono text-xs text-gray-400">{supporter.did}</td>
												<td className="px-4 py-2 text-gray-400">
													{supporter.created_at ? formatDbDate(supporter.created_at).toLocaleString() : 'N/A'}
												</td>
												<td className="px-4 py-2">
													<button
														onClick={() => removeSupporter(supporter.did)}
														className="px-3 py-1 bg-red-900 hover:bg-red-800 text-red-200 rounded text-xs font-medium transition-colors"
													>
														Remove
													</button>
												</td>
											</tr>
										))}
									</tbody>
								</table>
								{supporters.length === 0 && <div className="text-center text-gray-500 py-8">No supporters yet</div>}
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	)
}

// Main App
function App() {
	const [authenticated, setAuthenticated] = useState(false)
	const [checking, setChecking] = useState(true)

	useEffect(() => {
		fetch('/api/admin/status', { credentials: 'include' })
			.then((res) => res.json())
			.then((data) => {
				setAuthenticated(data.authenticated)
				setChecking(false)
			})
			.catch(() => {
				setChecking(false)
			})
	}, [])

	if (checking) {
		return (
			<div className="min-h-screen bg-gray-950 flex items-center justify-center">
				<div className="text-white">Loading...</div>
			</div>
		)
	}

	if (!authenticated) {
		return <Login onLogin={() => setAuthenticated(true)} />
	}

	return <Dashboard />
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
