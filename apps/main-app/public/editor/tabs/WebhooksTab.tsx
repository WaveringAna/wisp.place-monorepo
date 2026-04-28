import { Badge } from '@public/components/ui/badge'
import { Button } from '@public/components/ui/button'
import { Checkbox } from '@public/components/ui/checkbox'
import { Input } from '@public/components/ui/input'
import { Label } from '@public/components/ui/label'
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@public/components/ui/table'
import {
	CheckCircle2,
	ChevronDown,
	ChevronsUpDown,
	ChevronUp,
	Copy,
	ExternalLink,
	KeyRound,
	Loader2,
	Plus,
	RefreshCw,
	RotateCcw,
	Trash2,
	Webhook,
	X,
} from 'lucide-react'
import { type ChangeEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SecretMeta } from '../hooks/useSecretData'
import type { WebhookEventLog, WebhookRecord } from '../hooks/useWebhookData'

const APPS = [
	{ id: 'bluesky', label: 'Bluesky', path: 'app.bsky.*' },
	{ id: 'tangled', label: 'Tangled', path: 'sh.tangled.*' },
	{ id: 'leaflet', label: 'Leaflet', path: 'pub.leaflet.*' },
	{ id: 'wisp', label: 'wisp', path: 'place.wisp.*' },
	{ id: 'blento', label: 'Blento', path: 'blue.blento.*' },
] as const

type AppId = (typeof APPS)[number]['id'] | 'other'
type OtherMode = 'all' | 'collection' | 'rkey'

interface WebhooksTabProps {
	webhooks: WebhookRecord[]
	webhooksLoading: boolean
	eventLogs: WebhookEventLog[]
	eventLogsLoading: boolean
	isCreating: boolean
	userDid?: string
	secrets: SecretMeta[]
	secretsLoading: boolean
	isCreatingSecret: boolean
	onCreateWebhook: (data: {
		scopeAturi: string
		url: string
		backlinks: boolean
		events: string[]
		secret: string
		secretId?: string
		enabled: boolean
	}) => Promise<any>
	onDeleteWebhook: (rkey: string) => Promise<void>
	onRefreshEvents: () => Promise<void>
	onCreateSecret: (name: string) => Promise<{ token: string }>
	onDeleteSecret: (name: string) => Promise<void>
	onRotateSecret: (name: string) => Promise<{ token: string }>
}

function buildScope(
	did: string,
	selectedApp: AppId | null,
	scopePath: string,
	otherMode: OtherMode,
	otherCollection: string,
	otherRkey: string,
): string {
	if (!did) return ''
	if (!selectedApp) return ''
	if (selectedApp === 'other') {
		if (otherMode === 'all') return `at://${did}`
		if (otherMode === 'collection') return otherCollection ? `at://${did}/${otherCollection}` : ''
		return otherCollection && otherRkey ? `at://${did}/${otherCollection}/${otherRkey}` : ''
	}
	return scopePath ? `at://${did}/${scopePath}` : `at://${did}`
}

function formatTimeAgo(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime()
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return `${seconds}s ago`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return new Date(dateStr).toLocaleDateString()
}

export const WebhooksTab = memo(function WebhooksTab({
	webhooks,
	webhooksLoading,
	eventLogs,
	eventLogsLoading,
	isCreating,
	userDid = '',
	secrets,
	secretsLoading,
	isCreatingSecret,
	onCreateWebhook,
	onDeleteWebhook,
	onRefreshEvents,
	onCreateSecret,
	onDeleteSecret,
	onRotateSecret,
}: WebhooksTabProps) {
	const [url, setUrl] = useState('')
	const [selectedApp, setSelectedApp] = useState<AppId | null>(null)
	const [scopePath, setScopePath] = useState('')
	const [otherMode, setOtherMode] = useState<OtherMode>('all')
	const [otherCollection, setOtherCollection] = useState('')
	const [otherRkey, setOtherRkey] = useState('')
	const [customDid, setCustomDid] = useState('')
	const [useCustomDid, setUseCustomDid] = useState(false)
	const [selectedSecretId, setSelectedSecretId] = useState('')
	const [backlinks, setBacklinks] = useState(false)
	const [eventCreate, setEventCreate] = useState(true)
	const [eventUpdate, setEventUpdate] = useState(true)
	const [eventDelete, setEventDelete] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [success, setSuccess] = useState<string | null>(null)
	const [deletingRkey, setDeletingRkey] = useState<string | null>(null)
	const [showCreateForm, setShowCreateForm] = useState(false)
	const [focusedWebhook, setFocusedWebhook] = useState(0)
	const containerRef = useRef<HTMLDivElement>(null)
	const itemRefs = useRef<(HTMLDivElement | null)[]>([])

	// Secrets panel state
	const [showSecretsPanel, setShowSecretsPanel] = useState(false)
	const [newSecretName, setNewSecretName] = useState('')
	const [secretError, setSecretError] = useState<string | null>(null)
	const [revealedToken, setRevealedToken] = useState<{ name: string; token: string } | null>(null)
	const [deletingSecret, setDeletingSecret] = useState<string | null>(null)
	const [rotatingSecret, setRotatingSecret] = useState<string | null>(null)
	const [copiedToken, setCopiedToken] = useState(false)

	useEffect(() => {
		const id = setInterval(onRefreshEvents, 60_000)
		return () => clearInterval(id)
	}, [onRefreshEvents])

	// Auto-focus container when webhooks are loaded (fires on mount if data ready)
	useEffect(() => {
		if (!webhooksLoading && containerRef.current) {
			const timer = setTimeout(() => containerRef.current?.focus(), 100)
			return () => clearTimeout(timer)
		}
	}, [webhooksLoading])

	// Clamp focused index
	useEffect(() => {
		if (webhooks.length > 0 && focusedWebhook >= webhooks.length) {
			setFocusedWebhook(webhooks.length - 1)
		}
	}, [webhooks.length, focusedWebhook])

	const handleDelete = useCallback(
		async (rkey: string) => {
			setDeletingRkey(rkey)
			try {
				await onDeleteWebhook(rkey)
			} catch (err) {
				alert(err instanceof Error ? err.message : 'Failed to delete webhook')
			} finally {
				setDeletingRkey(null)
			}
		},
		[onDeleteWebhook],
	)

	// Keyboard navigation
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement
			const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
			const hasFocus = containerRef.current?.contains(document.activeElement)

			if (isTyping || !hasFocus || webhooks.length === 0 || showCreateForm) return

			switch (e.key) {
				case 'ArrowUp':
					e.preventDefault()
					setFocusedWebhook((prev) => Math.max(0, prev - 1))
					break
				case 'ArrowDown':
					e.preventDefault()
					setFocusedWebhook((prev) => Math.min(webhooks.length - 1, prev + 1))
					break
				case 'd':
					e.preventDefault()
					handleDelete(webhooks[focusedWebhook].rkey)
					break
				case 'n':
					e.preventDefault()
					setShowCreateForm(true)
					break
			}
		}

		window.addEventListener('keydown', handleKeyDown)
		return () => window.removeEventListener('keydown', handleKeyDown)
	}, [webhooks, focusedWebhook, showCreateForm, handleDelete])

	// Scroll focused item into view
	useEffect(() => {
		const element = itemRefs.current[focusedWebhook]
		if (element) {
			element.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
		}
	}, [focusedWebhook])

	const selectApp = (id: AppId) => {
		setSelectedApp(id)
		if (id !== 'other') {
			const app = APPS.find((a) => a.id === id)
			setScopePath(app?.path ?? '')
		}
		setError(null)
	}

	const effectiveDid = useCustomDid && customDid.trim() ? customDid.trim() : userDid
	const scopeAturi = buildScope(effectiveDid, selectedApp, scopePath, otherMode, otherCollection, otherRkey)

	const handleCreate = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setSuccess(null)

		if (!url.startsWith('http://') && !url.startsWith('https://')) {
			setError('URL must start with http:// or https://')
			return
		}
		if (!scopeAturi || !scopeAturi.startsWith('at://')) {
			setError('Please select an app scope above')
			return
		}

		const events: string[] = []
		if (eventCreate) events.push('create')
		if (eventUpdate) events.push('update')
		if (eventDelete) events.push('delete')

		try {
			await onCreateWebhook({
				url,
				scopeAturi,
				backlinks,
				events: events.length === 3 ? [] : events,
				secret: '',
				secretId: selectedSecretId || undefined,
				enabled: true,
			})
			setSuccess('Webhook created successfully')
			setUrl('')
			setSelectedApp(null)
			setScopePath('')
			setOtherMode('all')
			setOtherCollection('')
			setOtherRkey('')
			setCustomDid('')
			setUseCustomDid(false)
			setSelectedSecretId('')
			setBacklinks(false)
			setEventCreate(true)
			setEventUpdate(true)
			setEventDelete(true)
			setTimeout(() => {
				setSuccess(null)
				setShowCreateForm(false)
			}, 1500)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create webhook')
		}
	}

	// ── Delivery-table state ──────────────────────────────────────────────────
	type DeliveryColumn = 'status' | 'eventKind' | 'eventCollection' | 'url' | 'deliveredAt'
	const [sortCol, setSortCol] = useState<DeliveryColumn>('deliveredAt')
	const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
	const [filterScope, setFilterScope] = useState('')
	const [filterStatus, setFilterStatus] = useState<'all' | 'ok' | 'failed'>('all')
	const [filterKind, setFilterKind] = useState<string>('all')

	const handleSortCol = (col: DeliveryColumn) => {
		if (sortCol === col) {
			setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
		} else {
			setSortCol(col)
			setSortDir(col === 'deliveredAt' ? 'desc' : 'asc')
		}
	}

	const filteredLogs = useMemo(() => {
		let list = [...eventLogs]
		if (filterStatus !== 'all') list = list.filter((l) => l.status === filterStatus)
		if (filterKind !== 'all') list = list.filter((l) => l.eventKind === filterKind)
		if (filterScope.trim()) {
			const q = filterScope.trim().toLowerCase()
			list = list.filter((l) => l.eventCollection.toLowerCase().includes(q) || l.url.toLowerCase().includes(q))
		}
		list.sort((a, b) => {
			let valA: string
			let valB: string
			switch (sortCol) {
				case 'status':
					valA = a.status
					valB = b.status
					break
				case 'eventKind':
					valA = a.eventKind
					valB = b.eventKind
					break
				case 'eventCollection':
					valA = a.eventCollection
					valB = b.eventCollection
					break
				case 'url':
					valA = a.url
					valB = b.url
					break
				default:
					valA = a.deliveredAt
					valB = b.deliveredAt
					break
			}
			const cmp = valA < valB ? -1 : valA > valB ? 1 : 0
			return sortDir === 'asc' ? cmp : -cmp
		})
		return list
	}, [eventLogs, filterStatus, filterKind, filterScope, sortCol, sortDir])

	const uniqueKinds = useMemo(() => Array.from(new Set(eventLogs.map((l) => l.eventKind))).sort(), [eventLogs])

	const SortIcon = ({ col }: { col: DeliveryColumn }) => {
		if (sortCol !== col) return <ChevronsUpDown className="inline w-3 h-3 ml-1 opacity-30" />
		return sortDir === 'asc' ? (
			<ChevronUp className="inline w-3 h-3 ml-1" />
		) : (
			<ChevronDown className="inline w-3 h-3 ml-1" />
		)
	}
	// ─────────────────────────────────────────────────────────────────────────

	const Kbd = ({ children }: { children: React.ReactNode }) => (
		<kbd className="px-2 py-1 bg-muted/50 rounded border border-border/50">{children}</kbd>
	)

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: keyboard navigation container, interaction handled via window keydown listener
		// biome-ignore lint/a11y/useKeyWithClickEvents: onClick only focuses container, keyboard nav handled via useEffect
		<div
			ref={containerRef}
			className="h-full flex flex-col border border-border/30 bg-card/50 font-mono outline-none"
			tabIndex={-1}
			onClick={(e) => {
				const t = e.target as HTMLElement
				if (!t.closest('input, textarea, button, select, a, label')) {
					containerRef.current?.focus()
				}
			}}
		>
			{/* Header with keyboard hints */}
			<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground p-4 pb-3 border-b border-border/30 flex-shrink-0">
				{webhooks.length > 0 && !showCreateForm ? (
					<>
						<div className="flex items-center gap-2">
							<Kbd>↑</Kbd>
							<Kbd>↓</Kbd>
							<span>navigate</span>
						</div>
						<span>•</span>
						<div className="flex items-center gap-2">
							<Kbd>d</Kbd>
							<span className="text-red-400">delete</span>
						</div>
						<span>•</span>
						<div className="flex items-center gap-2">
							<Kbd>n</Kbd>
							<span>new</span>
						</div>
					</>
				) : (
					<>
						<Webhook className="w-3.5 h-3.5" />
						<span>Receive HTTP callbacks for changes to your ATProto collections as well as references</span>
					</>
				)}
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto">
				{/* Your Webhooks */}
				<div className="p-4 space-y-2">
					<div className="flex items-center justify-between mb-3">
						<p className="text-xs uppercase tracking-wider text-muted-foreground">Your Webhooks</p>
						<Button
							variant="outline"
							size="sm"
							className="h-7 text-xs px-3"
							onClick={() => setShowCreateForm(!showCreateForm)}
						>
							{showCreateForm ? (
								<>
									<ChevronUp className="w-3 h-3 mr-1.5" />
									Cancel
								</>
							) : (
								<>
									<Plus className="w-3 h-3 mr-1.5" />
									New Webhook
								</>
							)}
						</Button>
					</div>

					{/* Create form (collapsible) */}
					{showCreateForm && (
						<div className="border border-dashed border-border/50 p-4 space-y-4 mb-4">
							<form onSubmit={handleCreate} className="space-y-4">
								{/* URL */}
								<div className="space-y-1.5">
									<Label htmlFor="wh-url" className="text-xs text-muted-foreground">
										Endpoint URL
									</Label>
									<Input
										id="wh-url"
										value={url}
										onChange={(e: ChangeEvent<HTMLInputElement>) => setUrl(e.target.value)}
										placeholder="https://example.com/webhook"
										required
										className="h-8 text-sm font-mono"
										autoFocus
									/>
								</div>

								{/* App picker */}
								<div className="space-y-2">
									<Label className="text-xs text-muted-foreground">Scope</Label>
									<div className="flex flex-wrap gap-1.5">
										{APPS.map((app) => (
											<button
												key={app.id}
												type="button"
												onClick={() => selectApp(app.id)}
												className={`px-3 py-1.5 text-xs border rounded-sm transition-all ${
													selectedApp === app.id
														? 'border-accent bg-accent/15 text-foreground shadow-sm'
														: 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground hover:bg-muted/30'
												}`}
											>
												{app.label}
											</button>
										))}
										<button
											type="button"
											onClick={() => selectApp('other')}
											className={`px-3 py-1.5 text-xs border rounded-sm transition-all ${
												selectedApp === 'other'
													? 'border-accent bg-accent/15 text-foreground shadow-sm'
													: 'border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground hover:bg-muted/30'
											}`}
										>
											Other
										</button>
									</div>
								</div>

								{/* Scope detail — known app */}
								{selectedApp && selectedApp !== 'other' && (
									<div className="space-y-1.5">
										<Label htmlFor="wh-path" className="text-xs text-muted-foreground">
											Collection / glob
										</Label>
										<div className="flex items-center gap-0 border border-border rounded-sm focus-within:border-accent transition-colors">
											<span className="px-2.5 py-1.5 text-xs text-muted-foreground bg-muted/40 border-r border-border whitespace-nowrap select-none">
												at://{effectiveDid ? `${effectiveDid.slice(0, 16)}...` : 'did'}/
											</span>
											<input
												id="wh-path"
												value={scopePath}
												onChange={(e: ChangeEvent<HTMLInputElement>) => setScopePath(e.target.value)}
												placeholder="app.bsky.*"
												className="flex-1 px-2.5 py-1.5 text-xs bg-transparent outline-none font-mono"
											/>
										</div>
									</div>
								)}

								{/* Scope detail — other */}
								{selectedApp === 'other' && (
									<div className="space-y-2">
										<Label className="text-xs text-muted-foreground">Scope Level</Label>
										<div className="space-y-1.5">
											{(
												[
													['all', 'All my records'],
													['collection', 'Specific collection'],
													['rkey', 'Specific record'],
												] as const
											).map(([mode, label]) => (
												<label key={mode} className="flex items-center gap-2 cursor-pointer group">
													<input
														type="radio"
														name="other-mode"
														checked={otherMode === mode}
														onChange={() => setOtherMode(mode)}
														className="accent-accent"
													/>
													<span className="text-xs group-hover:text-foreground transition-colors">{label}</span>
												</label>
											))}
										</div>
										{otherMode === 'collection' && (
											<Input
												value={otherCollection}
												onChange={(e: ChangeEvent<HTMLInputElement>) => setOtherCollection(e.target.value)}
												placeholder="app.bsky.feed.post"
												className="h-8 text-xs font-mono"
											/>
										)}
										{otherMode === 'rkey' && (
											<div className="flex gap-2">
												<Input
													value={otherCollection}
													onChange={(e: ChangeEvent<HTMLInputElement>) => setOtherCollection(e.target.value)}
													placeholder="collection"
													className="h-8 text-xs flex-1 font-mono"
												/>
												<Input
													value={otherRkey}
													onChange={(e: ChangeEvent<HTMLInputElement>) => setOtherRkey(e.target.value)}
													placeholder="rkey"
													className="h-8 text-xs flex-1 font-mono"
												/>
											</div>
										)}
									</div>
								)}

								{/* Scope preview */}
								{scopeAturi && (
									<div className="p-2.5 bg-muted/20 border border-border/20 rounded-sm">
										<p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Scope Preview</p>
										<p className="text-xs font-mono break-all">{scopeAturi}</p>
									</div>
								)}

								{/* Wildcard hint */}
								{scopeAturi.includes('*') && (
									<p className="text-xs text-muted-foreground">
										<code className="bg-muted/50 px-1.5 py-0.5 rounded-sm border border-border/20">*</code> matches any
										collection name at that level
									</p>
								)}

								{/* Custom DID override */}
								<div className="space-y-1.5">
									<div className="flex items-center gap-2">
										<Checkbox
											id="wh-custom-did"
											checked={useCustomDid}
											onCheckedChange={(v: boolean | 'indeterminate') => setUseCustomDid(!!v)}
										/>
										<Label htmlFor="wh-custom-did" className="cursor-pointer text-xs">
											Custom scope DID (default: your DID)
										</Label>
									</div>
									{useCustomDid && (
										<Input
											value={customDid}
											onChange={(e: ChangeEvent<HTMLInputElement>) => setCustomDid(e.target.value)}
											placeholder="did:plc:..."
											className="h-8 text-xs font-mono"
										/>
									)}
								</div>

								{/* Options row */}
								{selectedApp && (
									<div className="flex flex-col sm:flex-row sm:items-start gap-4 pt-1">
										{/* Backlinks */}
										<div className="flex items-center gap-2">
											<Checkbox
												id="wh-backlinks"
												checked={backlinks}
												onCheckedChange={(v: boolean | 'indeterminate') => setBacklinks(!!v)}
											/>
											<Label htmlFor="wh-backlinks" className="cursor-pointer text-xs">
												Backlinks
											</Label>
										</div>

										{/* Events */}
										<div className="flex items-center gap-3">
											<span className="text-xs text-muted-foreground">Events:</span>
											{(
												[
													['create', eventCreate, setEventCreate],
													['update', eventUpdate, setEventUpdate],
													['delete', eventDelete, setEventDelete],
												] as const
											).map(([name, val, set]) => (
												<div key={name} className="flex items-center gap-1.5">
													<Checkbox
														id={`wh-event-${name}`}
														checked={val}
														onCheckedChange={(v: boolean | 'indeterminate') => set(!!v)}
													/>
													<Label htmlFor={`wh-event-${name}`} className="cursor-pointer text-xs capitalize">
														{name}
													</Label>
												</div>
											))}
										</div>
									</div>
								)}

								{/* Signing secret */}
								<div className="space-y-1.5">
									<Label className="text-xs text-muted-foreground">Signing Secret (optional)</Label>
									<select
										value={selectedSecretId}
										onChange={(e) => setSelectedSecretId(e.target.value)}
										className="h-8 w-full text-xs font-mono bg-background border border-border rounded-sm px-2.5 outline-none focus:border-accent transition-colors"
									>
										<option value="">— none —</option>
										{secrets.map((s) => (
											<option key={s.name} value={s.name}>
												{s.name}
											</option>
										))}
									</select>
									{secrets.length === 0 && (
										<p className="text-[10px] text-muted-foreground">
											No secrets yet — create one in the Secrets section below.
										</p>
									)}
								</div>

								{error && (
									<div className="p-2.5 bg-destructive/10 border border-destructive/20 rounded-sm">
										<p className="text-xs text-destructive">{error}</p>
									</div>
								)}
								{success && (
									<div className="p-2.5 bg-green-500/10 border border-green-500/20 rounded-sm flex items-center gap-2">
										<CheckCircle2 className="w-3 h-3 text-green-500" />
										<p className="text-xs text-green-500">{success}</p>
									</div>
								)}

								{selectedApp && (
									<Button type="submit" disabled={isCreating || !scopeAturi} size="sm" className="w-full sm:w-auto">
										{isCreating ? (
											<>
												<Loader2 className="w-3 h-3 mr-2 animate-spin" />
												Creating...
											</>
										) : (
											'Create Webhook'
										)}
									</Button>
								)}
							</form>
						</div>
					)}

					{/* Webhook list */}
					{webhooksLoading ? (
						<div className="space-y-2">
							{['a', 'b'].map((id) => (
								<SkeletonShimmer key={id} className="h-16 w-full" />
							))}
						</div>
					) : webhooks.length === 0 ? (
						<div className="py-8 text-center space-y-3">
							<Webhook className="w-6 h-6 text-muted-foreground/50 mx-auto" />
							<div>
								<p className="text-sm text-muted-foreground">No webhooks configured</p>
								<p className="text-xs text-muted-foreground/70 mt-1 max-w-xs mx-auto">
									Create one to receive HTTP callbacks for changes to your ATProto collections
								</p>
							</div>
							{!showCreateForm && (
								<Button variant="outline" size="sm" className="text-xs" onClick={() => setShowCreateForm(true)}>
									<Plus className="w-3 h-3 mr-1.5" />
									Create your first webhook
								</Button>
							)}
						</div>
					) : (
						<div className="space-y-1.5">
							{webhooks.map((wh, idx) => {
								const isFocused = idx === focusedWebhook
								// Extract the collection/path from the AT-URI for display
								const scopeParts = wh.scopeAturi.replace('at://', '').split('/')
								const scopeDisplay = scopeParts.slice(1).join('/') || 'all records'

								return (
									<div
										key={wh.rkey}
										ref={(el) => {
											itemRefs.current[idx] = el
										}}
										className={`flex items-start justify-between p-3 border transition-colors ${
											isFocused ? 'border-accent bg-accent/10' : 'border-border/30 hover:bg-muted/10'
										}`}
									>
										<div className="space-y-1.5 min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<div
													className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${wh.enabled ? 'bg-green-500' : 'bg-muted-foreground/30'}`}
												/>
												<p className="text-xs font-medium truncate">{wh.url}</p>
												<a
													href={wh.url}
													target="_blank"
													rel="noopener noreferrer"
													className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
													onClick={(e) => e.stopPropagation()}
												>
													<ExternalLink className="w-2.5 h-2.5" />
												</a>
											</div>
											<p className="text-xs text-muted-foreground truncate ml-3.5 font-mono">{scopeDisplay}</p>
											<div className="flex gap-1 flex-wrap ml-3.5">
												{!wh.enabled && (
													<Badge variant="secondary" className="text-[10px]">
														disabled
													</Badge>
												)}
												{wh.backlinks && (
													<Badge variant="outline" className="text-[10px]">
														backlinks
													</Badge>
												)}
												{wh.secretId && (
													<Badge variant="outline" className="text-[10px] gap-1">
														<KeyRound className="w-2.5 h-2.5" />
														{wh.secretId}
													</Badge>
												)}
												{wh.events.length > 0 ? (
													wh.events.map((e) => (
														<Badge key={e} variant="outline" className="text-[10px]">
															{e}
														</Badge>
													))
												) : (
													<Badge variant="outline" className="text-[10px]">
														all events
													</Badge>
												)}
											</div>
										</div>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => handleDelete(wh.rkey)}
											disabled={deletingRkey === wh.rkey}
											className="flex-shrink-0 h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
										>
											{deletingRkey === wh.rkey ? (
												<Loader2 className="w-3 h-3 animate-spin" />
											) : (
												<Trash2 className="w-3 h-3" />
											)}
										</Button>
									</div>
								)
							})}
						</div>
					)}
				</div>

				{/* Signing Secrets */}
				<div className="p-4 border-t border-border/30 space-y-3">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<KeyRound className="w-3.5 h-3.5 text-muted-foreground" />
							<p className="text-xs uppercase tracking-wider text-muted-foreground">Signing Secrets</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							className="h-7 text-xs px-3"
							onClick={() => {
								setShowSecretsPanel((v) => !v)
								setSecretError(null)
								setRevealedToken(null)
							}}
						>
							{showSecretsPanel ? (
								<>
									<ChevronUp className="w-3 h-3 mr-1.5" />
									Hide
								</>
							) : (
								<>
									<ChevronDown className="w-3 h-3 mr-1.5" />
									Manage
								</>
							)}
						</Button>
					</div>

					{showSecretsPanel && (
						<div className="space-y-3">
							{/* Create new secret */}
							<div className="flex gap-2">
								<Input
									value={newSecretName}
									onChange={(e: ChangeEvent<HTMLInputElement>) => setNewSecretName(e.target.value)}
									placeholder="secret name (e.g. my-server)"
									className="h-8 text-xs font-mono flex-1"
								/>
								<Button
									size="sm"
									className="h-8 text-xs px-3 flex-shrink-0"
									disabled={isCreatingSecret || !newSecretName.trim()}
									onClick={async () => {
										setSecretError(null)
										setRevealedToken(null)
										try {
											const { token } = await onCreateSecret(newSecretName.trim())
											setRevealedToken({ name: newSecretName.trim(), token })
											setNewSecretName('')
										} catch (err) {
											setSecretError(err instanceof Error ? err.message : 'Failed to create secret')
										}
									}}
								>
									{isCreatingSecret ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3 mr-1" />}
									Create
								</Button>
							</div>

							{secretError && <p className="text-xs text-destructive">{secretError}</p>}

							{/* Revealed token — show once */}
							{revealedToken && (
								<div className="p-3 bg-green-500/10 border border-green-500/20 rounded-sm space-y-2">
									<p className="text-[10px] uppercase tracking-wider text-green-500">
										New token for <strong>{revealedToken.name}</strong> — copy it now, it won't be shown again
									</p>
									<div className="flex items-center gap-2">
										<code className="text-xs font-mono break-all flex-1 text-green-400">{revealedToken.token}</code>
										<button
											type="button"
											onClick={() => {
												navigator.clipboard.writeText(revealedToken.token)
												setCopiedToken(true)
												setTimeout(() => setCopiedToken(false), 2000)
											}}
											className="flex-shrink-0 text-green-400 hover:text-green-300"
										>
											{copiedToken ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
										</button>
									</div>
								</div>
							)}

							{/* Secret list */}
							{secretsLoading ? (
								<SkeletonShimmer className="h-8 w-full" />
							) : secrets.length === 0 ? (
								<p className="text-xs text-muted-foreground py-2 text-center">No secrets yet</p>
							) : (
								<div className="space-y-1">
									{secrets.map((s) => (
										<div
											key={s.name}
											className="flex items-center justify-between p-2.5 border border-border/30 rounded-sm"
										>
											<div className="space-y-0.5 min-w-0 flex-1">
												<p className="text-xs font-mono font-medium">{s.name}</p>
												<p className="text-[10px] text-muted-foreground">
													Created {new Date(s.createdAt).toLocaleDateString()}
													{s.lastRotatedAt && ` · rotated ${new Date(s.lastRotatedAt).toLocaleDateString()}`}
												</p>
											</div>
											<div className="flex items-center gap-1 flex-shrink-0">
												<Button
													variant="ghost"
													size="sm"
													className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
													disabled={rotatingSecret === s.name}
													title="Rotate"
													onClick={async () => {
														setSecretError(null)
														setRevealedToken(null)
														setRotatingSecret(s.name)
														try {
															const { token } = await onRotateSecret(s.name)
															setRevealedToken({ name: s.name, token })
														} catch (err) {
															setSecretError(err instanceof Error ? err.message : 'Failed to rotate secret')
														} finally {
															setRotatingSecret(null)
														}
													}}
												>
													{rotatingSecret === s.name ? (
														<Loader2 className="w-3 h-3 animate-spin" />
													) : (
														<RotateCcw className="w-3 h-3" />
													)}
												</Button>
												<Button
													variant="ghost"
													size="sm"
													className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
													disabled={deletingSecret === s.name}
													title="Delete"
													onClick={async () => {
														setSecretError(null)
														setDeletingSecret(s.name)
														try {
															await onDeleteSecret(s.name)
														} catch (err) {
															setSecretError(err instanceof Error ? err.message : 'Failed to delete secret')
														} finally {
															setDeletingSecret(null)
														}
													}}
												>
													{deletingSecret === s.name ? (
														<Loader2 className="w-3 h-3 animate-spin" />
													) : (
														<Trash2 className="w-3 h-3" />
													)}
												</Button>
											</div>
										</div>
									))}
								</div>
							)}
						</div>
					)}
				</div>

				{/* Event Logs — table */}
				<div className="p-4 border-t border-border/30 space-y-3">
					{/* Section header */}
					<div className="flex items-center justify-between">
						<p className="text-xs uppercase tracking-wider text-muted-foreground">Recent Deliveries</p>
						<Button
							variant="outline"
							size="sm"
							onClick={onRefreshEvents}
							disabled={eventLogsLoading}
							className="h-7 px-2 gap-1.5 text-xs"
						>
							<RefreshCw className={`w-3 h-3 ${eventLogsLoading ? 'animate-spin' : ''}`} />
							Refresh
						</Button>
					</div>

					{/* Filter bar — only show when there's data */}
					{!eventLogsLoading && eventLogs.length > 0 && (
						<div className="flex flex-wrap gap-2 items-center">
							{/* Scope / URL search */}
							<div className="relative">
								<Input
									value={filterScope}
									onChange={(e: ChangeEvent<HTMLInputElement>) => setFilterScope(e.target.value)}
									placeholder="Filter by collection or URL…"
									className="h-7 text-xs pr-7 w-72 font-mono"
								/>
								{filterScope && (
									<button
										type="button"
										onClick={() => setFilterScope('')}
										className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
									>
										<X className="w-3 h-3" />
									</button>
								)}
							</div>

							{/* Status filter */}
							<div className="flex items-center gap-1 border border-border/30 rounded-sm overflow-hidden">
								{(['all', 'ok', 'failed'] as const).map((s) => (
									<button
										key={s}
										type="button"
										onClick={() => setFilterStatus(s)}
										className={`px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors ${
											filterStatus === s
												? s === 'failed'
													? 'bg-destructive/20 text-destructive'
													: s === 'ok'
														? 'bg-green-500/20 text-green-500'
														: 'bg-accent/20 text-foreground'
												: 'text-muted-foreground hover:text-foreground hover:bg-muted/20'
										}`}
									>
										{s}
									</button>
								))}
							</div>

							{/* Event-kind filter */}
							{uniqueKinds.length > 0 && (
								<div className="flex items-center gap-1 border border-border/30 rounded-sm overflow-hidden">
									<button
										type="button"
										onClick={() => setFilterKind('all')}
										className={`px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors ${
											filterKind === 'all'
												? 'bg-accent/20 text-foreground'
												: 'text-muted-foreground hover:text-foreground hover:bg-muted/20'
										}`}
									>
										all
									</button>
									{uniqueKinds.map((k) => (
										<button
											key={k}
											type="button"
											onClick={() => setFilterKind(k)}
											className={`px-2.5 py-1 text-[10px] uppercase tracking-wider capitalize transition-colors ${
												filterKind === k
													? 'bg-accent/20 text-foreground'
													: 'text-muted-foreground hover:text-foreground hover:bg-muted/20'
											}`}
										>
											{k}
										</button>
									))}
								</div>
							)}

							{/* Active-filter count badge */}
							{filteredLogs.length !== eventLogs.length && (
								<span className="text-[10px] text-muted-foreground">
									{filteredLogs.length} / {eventLogs.length}
								</span>
							)}
						</div>
					)}

					{/* Table */}
					{eventLogsLoading ? (
						<div className="space-y-1.5">
							{['a', 'b', 'c'].map((id) => (
								<SkeletonShimmer key={id} className="h-9 w-full" />
							))}
						</div>
					) : eventLogs.length === 0 ? (
						<p className="text-xs text-muted-foreground py-4 text-center">No delivery events yet</p>
					) : filteredLogs.length === 0 ? (
						<p className="text-xs text-muted-foreground py-4 text-center">No deliveries match the current filters</p>
					) : (
						<div className="border border-border/30 rounded-sm overflow-hidden">
							<Table>
								<TableHeader>
									<TableRow className="hover:bg-transparent">
										{/* Status */}
										<TableHead className="cursor-pointer select-none w-16" onClick={() => handleSortCol('status')}>
											Status <SortIcon col="status" />
										</TableHead>
										{/* Event kind */}
										<TableHead className="cursor-pointer select-none w-24" onClick={() => handleSortCol('eventKind')}>
											Event <SortIcon col="eventKind" />
										</TableHead>
										{/* Collection / scope */}
										<TableHead className="cursor-pointer select-none" onClick={() => handleSortCol('eventCollection')}>
											Collection <SortIcon col="eventCollection" />
										</TableHead>
										{/* URL */}
										<TableHead
											className="cursor-pointer select-none hidden md:table-cell"
											onClick={() => handleSortCol('url')}
										>
											Endpoint <SortIcon col="url" />
										</TableHead>
										{/* Time */}
										<TableHead
											className="cursor-pointer select-none w-24 text-right"
											onClick={() => handleSortCol('deliveredAt')}
										>
											Time <SortIcon col="deliveredAt" />
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{filteredLogs.map((log) => (
										<TableRow key={`${log.rkey}-${log.deliveredAt}`}>
											{/* Status */}
											<TableCell>
												<Badge
													variant={log.status === 'ok' ? 'default' : 'destructive'}
													className="text-[10px] tabular-nums"
												>
													{log.status === 'ok' ? '200' : 'ERR'}
												</Badge>
											</TableCell>

											{/* Event kind */}
											<TableCell>
												<span className="text-xs capitalize font-medium">{log.eventKind}</span>
											</TableCell>

											{/* Collection */}
											<TableCell>
												<span
													className="text-xs font-mono text-muted-foreground truncate block max-w-[16rem]"
													title={log.eventCollection}
												>
													{log.eventCollection || '—'}
												</span>
											</TableCell>

											{/* URL */}
											<TableCell className="hidden md:table-cell">
												<a
													href={log.url}
													target="_blank"
													rel="noopener noreferrer"
													className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 max-w-[14rem] truncate transition-colors"
													title={log.url}
												>
													<span className="truncate">{log.url}</span>
													<ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
												</a>
											</TableCell>

											{/* Time */}
											<TableCell className="text-right">
												<span className="text-[10px] text-muted-foreground whitespace-nowrap">
													{formatTimeAgo(log.deliveredAt)}
												</span>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
				</div>
			</div>
		</div>
	)
})
