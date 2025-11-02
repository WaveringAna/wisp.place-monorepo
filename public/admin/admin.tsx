import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

// Types
interface LogEntry {
	id: string
	timestamp: string
	level: 'info' | 'warn' | 'error' | 'debug'
	message: string
	service: string
	context?: Record<string, any>
	eventType?: string
}

interface ErrorEntry {
	id: string
	timestamp: string
	message: string
	stack?: string
	service: string
	count: number
	lastSeen: string
}

interface MetricsStats {
	totalRequests: number
	avgDuration: number
	p50Duration: number
	p95Duration: number
	p99Duration: number
	errorRate: number
	requestsPerMinute: number
}

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
				credentials: 'include'
			})

			if (res.ok) {
				onLogin()
			} else {
				setError('Invalid credentials')
			}
		} catch (err) {
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
							<label className="block text-sm font-medium text-gray-300 mb-2">
								Username
							</label>
							<input
								type="text"
								value={username}
								onChange={(e) => setUsername(e.target.value)}
								className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
								required
							/>
						</div>
						<div>
							<label className="block text-sm font-medium text-gray-300 mb-2">
								Password
							</label>
							<input
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white focus:outline-none focus:border-blue-500"
								required
							/>
						</div>
						{error && (
							<div className="text-red-400 text-sm">{error}</div>
						)}
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
	const [logs, setLogs] = useState<LogEntry[]>([])
	const [errors, setErrors] = useState<ErrorEntry[]>([])
	const [metrics, setMetrics] = useState<any>(null)
	const [database, setDatabase] = useState<any>(null)
	const [sites, setSites] = useState<any>(null)
	const [health, setHealth] = useState<any>(null)
	const [autoRefresh, setAutoRefresh] = useState(true)

	// Filters
	const [logLevel, setLogLevel] = useState('')
	const [logService, setLogService] = useState('')
	const [logSearch, setLogSearch] = useState('')
	const [logEventType, setLogEventType] = useState('')

	const fetchLogs = async () => {
		const params = new URLSearchParams()
		if (logLevel) params.append('level', logLevel)
		if (logService) params.append('service', logService)
		if (logSearch) params.append('search', logSearch)
		if (logEventType) params.append('eventType', logEventType)
		params.append('limit', '100')

		const res = await fetch(`/api/admin/logs?${params}`, { credentials: 'include' })
		if (res.ok) {
			const data = await res.json()
			setLogs(data.logs)
		}
	}

	const fetchErrors = async () => {
		const res = await fetch('/api/admin/errors', { credentials: 'include' })
		if (res.ok) {
			const data = await res.json()
			setErrors(data.errors)
		}
	}

	const fetchMetrics = async () => {
		const res = await fetch('/api/admin/metrics', { credentials: 'include' })
		if (res.ok) {
			const data = await res.json()
			setMetrics(data)
		}
	}

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

	const logout = async () => {
		await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' })
		window.location.reload()
	}

	useEffect(() => {
		fetchMetrics()
		fetchDatabase()
		fetchHealth()
		fetchLogs()
		fetchErrors()
		fetchSites()
	}, [])

	useEffect(() => {
		fetchLogs()
	}, [logLevel, logService, logSearch])

	useEffect(() => {
		if (!autoRefresh) return

		const interval = setInterval(() => {
			if (tab === 'overview') {
				fetchMetrics()
				fetchHealth()
			} else if (tab === 'logs') {
				fetchLogs()
			} else if (tab === 'errors') {
				fetchErrors()
			} else if (tab === 'database') {
				fetchDatabase()
			} else if (tab === 'sites') {
				fetchSites()
			}
		}, 5000)

		return () => clearInterval(interval)
	}, [tab, autoRefresh, logLevel, logService, logSearch])

	const formatDuration = (ms: number) => {
		if (ms < 1000) return `${ms}ms`
		return `${(ms / 1000).toFixed(2)}s`
	}

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
						<button
							onClick={logout}
							className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm"
						>
							Logout
						</button>
					</div>
				</div>
			</div>

			{/* Tabs */}
			<div className="bg-gray-900 border-b border-gray-800 px-6">
				<div className="flex gap-1">
					{['overview', 'logs', 'errors', 'database', 'sites'].map((t) => (
						<button
							key={t}
							onClick={() => setTab(t)}
							className={`px-4 py-3 text-sm font-medium capitalize transition-colors ${
								tab === t
									? 'text-white border-b-2 border-blue-500'
									: 'text-gray-400 hover:text-white'
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

						{/* Metrics */}
						{metrics && (
							<div>
								<h2 className="text-xl font-bold mb-4">Performance Metrics</h2>
								<div className="space-y-4">
									{/* Overall */}
									<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
										<h3 className="text-lg font-semibold mb-3">Overall (Last Hour)</h3>
										<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
											<div>
												<div className="text-sm text-gray-400">Total Requests</div>
												<div className="text-xl font-bold">{metrics.overall.totalRequests}</div>
											</div>
											<div>
												<div className="text-sm text-gray-400">Avg Duration</div>
												<div className="text-xl font-bold">{metrics.overall.avgDuration}ms</div>
											</div>
											<div>
												<div className="text-sm text-gray-400">P95 Duration</div>
												<div className="text-xl font-bold">{metrics.overall.p95Duration}ms</div>
											</div>
											<div>
												<div className="text-sm text-gray-400">Error Rate</div>
												<div className="text-xl font-bold">{metrics.overall.errorRate.toFixed(2)}%</div>
											</div>
										</div>
									</div>

									{/* Main App */}
									<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
										<h3 className="text-lg font-semibold mb-3">Main App</h3>
										<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
											<div>
												<div className="text-sm text-gray-400">Requests</div>
												<div className="text-xl font-bold">{metrics.mainApp.totalRequests}</div>
											</div>
											<div>
												<div className="text-sm text-gray-400">Avg</div>
												<div className="text-xl font-bold">{metrics.mainApp.avgDuration}ms</div>
											</div>
											<div>
												<div className="text-sm text-gray-400">P95</div>
												<div className="text-xl font-bold">{metrics.mainApp.p95Duration}ms</div>
											</div>
											<div>
												<div className="text-sm text-gray-400">Req/min</div>
												<div className="text-xl font-bold">{metrics.mainApp.requestsPerMinute}</div>
											</div>
										</div>
									</div>

									{/* Hosting Service */}
									<div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
										<h3 className="text-lg font-semibold mb-3">Hosting Service</h3>
										<div className="grid grid-cols-2 md:grid-cols-4 gap-4">
											<div>
												<div className="text-sm text-gray-400">Requests</div>
												<div className="text-xl font-bold">{metrics.hostingService.totalRequests}</div>
											</div>
											<div>
												<div className="text-sm text-gray-400">Avg</div>
												<div className="text-xl font-bold">{metrics.hostingService.avgDuration}ms</div>
											</div>
											<div>
												<div className="text-sm text-gray-400">P95</div>
												<div className="text-xl font-bold">{metrics.hostingService.p95Duration}ms</div>
											</div>
											<div>
												<div className="text-sm text-gray-400">Req/min</div>
												<div className="text-xl font-bold">{metrics.hostingService.requestsPerMinute}</div>
											</div>
										</div>
									</div>
								</div>
							</div>
						)}
					</div>
				)}

				{tab === 'logs' && (
					<div className="space-y-4">
						<div className="flex gap-4">
							<select
								value={logLevel}
								onChange={(e) => setLogLevel(e.target.value)}
								className="px-3 py-2 bg-gray-900 border border-gray-800 rounded text-white"
							>
								<option value="">All Levels</option>
								<option value="info">Info</option>
								<option value="warn">Warn</option>
								<option value="error">Error</option>
								<option value="debug">Debug</option>
							</select>
							<select
								value={logService}
								onChange={(e) => setLogService(e.target.value)}
								className="px-3 py-2 bg-gray-900 border border-gray-800 rounded text-white"
							>
								<option value="">All Services</option>
								<option value="main-app">Main App</option>
								<option value="hosting-service">Hosting Service</option>
							</select>
							<select
								value={logEventType}
								onChange={(e) => setLogEventType(e.target.value)}
								className="px-3 py-2 bg-gray-900 border border-gray-800 rounded text-white"
							>
								<option value="">All Event Types</option>
								<option value="DNS Verifier">DNS Verifier</option>
								<option value="Auth">Auth</option>
								<option value="User">User</option>
								<option value="Domain">Domain</option>
								<option value="Site">Site</option>
								<option value="File Upload">File Upload</option>
								<option value="Sync">Sync</option>
								<option value="Maintenance">Maintenance</option>
								<option value="KeyRotation">Key Rotation</option>
								<option value="Cleanup">Cleanup</option>
								<option value="Cache">Cache</option>
								<option value="FirehoseWorker">Firehose Worker</option>
							</select>
							<input
								type="text"
								value={logSearch}
								onChange={(e) => setLogSearch(e.target.value)}
								placeholder="Search logs..."
								className="flex-1 px-3 py-2 bg-gray-900 border border-gray-800 rounded text-white"
							/>
						</div>

						<div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
							<div className="max-h-[600px] overflow-y-auto">
								<table className="w-full text-sm">
									<thead className="bg-gray-800 sticky top-0">
										<tr>
											<th className="px-4 py-2 text-left">Time</th>
											<th className="px-4 py-2 text-left">Level</th>
											<th className="px-4 py-2 text-left">Service</th>
											<th className="px-4 py-2 text-left">Event Type</th>
											<th className="px-4 py-2 text-left">Message</th>
										</tr>
									</thead>
									<tbody>
										{logs.map((log) => (
											<tr key={log.id} className="border-t border-gray-800 hover:bg-gray-800">
												<td className="px-4 py-2 text-gray-400 whitespace-nowrap">
													{new Date(log.timestamp).toLocaleTimeString()}
												</td>
												<td className="px-4 py-2">
													<span
														className={`px-2 py-1 rounded text-xs font-medium ${
															log.level === 'error'
																? 'bg-red-900 text-red-200'
																: log.level === 'warn'
																? 'bg-yellow-900 text-yellow-200'
																: log.level === 'info'
																? 'bg-blue-900 text-blue-200'
																: 'bg-gray-700 text-gray-300'
														}`}
													>
														{log.level}
													</span>
												</td>
												<td className="px-4 py-2 text-gray-400">{log.service}</td>
												<td className="px-4 py-2">
													{log.eventType && (
														<span className="px-2 py-1 bg-purple-900 text-purple-200 rounded text-xs font-medium">
															{log.eventType}
														</span>
													)}
												</td>
												<td className="px-4 py-2">
													<div>{log.message}</div>
													{log.context && Object.keys(log.context).length > 0 && (
														<div className="text-xs text-gray-500 mt-1">
															{JSON.stringify(log.context)}
														</div>
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</div>
					</div>
				)}

				{tab === 'errors' && (
					<div className="space-y-4">
						<h2 className="text-xl font-bold">Recent Errors</h2>
						<div className="space-y-3">
							{errors.map((error) => (
								<div key={error.id} className="bg-gray-900 border border-red-900 rounded-lg p-4">
									<div className="flex items-start justify-between mb-2">
										<div className="flex-1">
											<div className="font-semibold text-red-400">{error.message}</div>
											<div className="text-sm text-gray-400 mt-1">
												Service: {error.service} • Count: {error.count} • Last seen:{' '}
												{new Date(error.lastSeen).toLocaleString()}
											</div>
										</div>
									</div>
									{error.stack && (
										<pre className="text-xs text-gray-500 bg-gray-950 p-2 rounded mt-2 overflow-x-auto">
											{error.stack}
										</pre>
									)}
								</div>
							))}
							{errors.length === 0 && (
								<div className="text-center text-gray-500 py-8">No errors found</div>
							)}
						</div>
					</div>
				)}

				{tab === 'database' && database && (
					<div className="space-y-6">
						{/* Stats */}
						<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
						</div>

						{/* Recent Sites */}
						<div>
							<h3 className="text-lg font-semibold mb-3">Recent Sites</h3>
							<div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
								<table className="w-full text-sm">
									<thead className="bg-gray-800">
										<tr>
											<th className="px-4 py-2 text-left">Site Name</th>
											<th className="px-4 py-2 text-left">Subdomain</th>
											<th className="px-4 py-2 text-left">DID</th>
											<th className="px-4 py-2 text-left">RKey</th>
											<th className="px-4 py-2 text-left">Created</th>
										</tr>
									</thead>
									<tbody>
										{database.recentSites.map((site: any, i: number) => (
											<tr key={i} className="border-t border-gray-800">
												<td className="px-4 py-2">{site.display_name || 'Untitled'}</td>
												<td className="px-4 py-2">
													{site.subdomain ? (
														<a
															href={`https://${site.subdomain}`}
															target="_blank"
															rel="noopener noreferrer"
															className="text-blue-400 hover:underline"
														>
															{site.subdomain}
														</a>
													) : (
														<span className="text-gray-500">No domain</span>
													)}
												</td>
												<td className="px-4 py-2 text-gray-400 font-mono text-xs">
													{site.did.slice(0, 20)}...
												</td>
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
															<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
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
											<th className="px-4 py-2 text-left">Verified</th>
											<th className="px-4 py-2 text-left">Created</th>
										</tr>
									</thead>
									<tbody>
										{database.recentDomains.map((domain: any, i: number) => (
											<tr key={i} className="border-t border-gray-800">
												<td className="px-4 py-2">{domain.domain}</td>
												<td className="px-4 py-2 text-gray-400 font-mono text-xs">
													{domain.did.slice(0, 20)}...
												</td>
												<td className="px-4 py-2">
													<span
														className={`px-2 py-1 rounded text-xs ${
															domain.verified
																? 'bg-green-900 text-green-200'
																: 'bg-yellow-900 text-yellow-200'
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
											<th className="px-4 py-2 text-left">Subdomain</th>
											<th className="px-4 py-2 text-left">DID</th>
											<th className="px-4 py-2 text-left">RKey</th>
											<th className="px-4 py-2 text-left">Created</th>
										</tr>
									</thead>
									<tbody>
										{sites.sites.map((site: any, i: number) => (
											<tr key={i} className="border-t border-gray-800 hover:bg-gray-800">
												<td className="px-4 py-2">{site.display_name || 'Untitled'}</td>
												<td className="px-4 py-2">
													{site.subdomain ? (
														<a
															href={`https://${site.subdomain}`}
															target="_blank"
															rel="noopener noreferrer"
															className="text-blue-400 hover:underline"
														>
															{site.subdomain}
														</a>
													) : (
														<span className="text-gray-500">No domain</span>
													)}
												</td>
												<td className="px-4 py-2 text-gray-400 font-mono text-xs">
													{site.did.slice(0, 30)}...
												</td>
												<td className="px-4 py-2 text-gray-400">{site.rkey || 'self'}</td>
												<td className="px-4 py-2 text-gray-400">
													{formatDbDate(site.created_at).toLocaleString()}
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
															<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
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
															domain.verified
																? 'bg-green-900 text-green-200'
																: 'bg-yellow-900 text-yellow-200'
														}`}
													>
														{domain.verified ? 'Yes' : 'Pending'}
													</span>
												</td>
												<td className="px-4 py-2 text-gray-400 font-mono text-xs">
													{domain.did.slice(0, 30)}...
												</td>
												<td className="px-4 py-2 text-gray-400">{domain.rkey || 'self'}</td>
												<td className="px-4 py-2 text-gray-400">
													{formatDbDate(domain.created_at).toLocaleString()}
												</td>
												<td className="px-4 py-2">
													<a
														href={`https://pdsls.dev/at://${domain.did}/place.wisp.fs/${domain.rkey || 'self'}`}
														target="_blank"
														rel="noopener noreferrer"
														className="text-blue-400 hover:text-blue-300 transition-colors"
														title="View on PDSls.dev"
													>
														<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
															<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
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
	</StrictMode>
)
