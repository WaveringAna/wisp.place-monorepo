import { useState, useEffect } from 'react'
import { Button } from '@public/components/ui/button'
import { Input } from '@public/components/ui/input'
import { Checkbox } from '@public/components/ui/checkbox'
import { Label } from '@public/components/ui/label'
import { Badge } from '@public/components/ui/badge'
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { WebhookRecord, WebhookEventLog } from '../hooks/useWebhookData'

const APPS = [
	{ id: 'bluesky',  label: 'Bluesky',  path: 'app.bsky.*' },
	{ id: 'tangled',  label: 'Tangled',   path: 'chat.tangled.*' },
	{ id: 'leaflet',  label: 'Leaflet',   path: 'pub.leaflet.*' },
	{ id: 'wisp',     label: 'wisp',      path: 'place.wisp.*' },
	{ id: 'blento',   label: 'Blento',    path: 'blue.blento.*' },
] as const

type AppId = typeof APPS[number]['id'] | 'other'
type OtherMode = 'all' | 'collection' | 'rkey'

interface WebhooksTabProps {
	webhooks: WebhookRecord[]
	webhooksLoading: boolean
	eventLogs: WebhookEventLog[]
	eventLogsLoading: boolean
	isCreating: boolean
	userDid?: string
	onCreateWebhook: (data: {
		scopeAturi: string
		url: string
		backlinks: boolean
		events: string[]
		secret: string
		enabled: boolean
	}) => Promise<any>
	onDeleteWebhook: (rkey: string) => Promise<void>
	onRefreshEvents: () => Promise<void>
}

function buildScope(userDid: string, selectedApp: AppId | null, scopePath: string, otherMode: OtherMode, otherCollection: string, otherRkey: string): string {
	if (!userDid) return ''
	if (!selectedApp) return ''
	if (selectedApp === 'other') {
		if (otherMode === 'all') return `at://${userDid}`
		if (otherMode === 'collection') return otherCollection ? `at://${userDid}/${otherCollection}` : ''
		return (otherCollection && otherRkey) ? `at://${userDid}/${otherCollection}/${otherRkey}` : ''
	}
	return scopePath ? `at://${userDid}/${scopePath}` : `at://${userDid}`
}

export function WebhooksTab({
	webhooks,
	webhooksLoading,
	eventLogs,
	eventLogsLoading,
	isCreating,
	userDid = '',
	onCreateWebhook,
	onDeleteWebhook,
	onRefreshEvents,
}: WebhooksTabProps) {
	const [url, setUrl] = useState('')
	const [selectedApp, setSelectedApp] = useState<AppId | null>(null)
	const [scopePath, setScopePath] = useState('')
	const [otherMode, setOtherMode] = useState<OtherMode>('all')
	const [otherCollection, setOtherCollection] = useState('')
	const [otherRkey, setOtherRkey] = useState('')
	const [backlinks, setBacklinks] = useState(false)
	const [eventCreate, setEventCreate] = useState(true)
	const [eventUpdate, setEventUpdate] = useState(true)
	const [eventDelete, setEventDelete] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [success, setSuccess] = useState<string | null>(null)
	const [deletingRkey, setDeletingRkey] = useState<string | null>(null)

	useEffect(() => {
		const id = setInterval(onRefreshEvents, 60_000)
		return () => clearInterval(id)
	}, [onRefreshEvents])

	const selectApp = (id: AppId) => {
		setSelectedApp(id)
		if (id !== 'other') {
			const app = APPS.find(a => a.id === id)
			setScopePath(app?.path ?? '')
		}
		setError(null)
	}

	const scopeAturi = buildScope(userDid, selectedApp, scopePath, otherMode, otherCollection, otherRkey)

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
			await onCreateWebhook({ url, scopeAturi, backlinks, events: events.length === 3 ? [] : events, secret: '', enabled: true })
			setSuccess('Webhook created.')
			setUrl('')
			setSelectedApp(null)
			setScopePath('')
			setOtherMode('all')
			setOtherCollection('')
			setOtherRkey('')
			setBacklinks(false)
			setEventCreate(true)
			setEventUpdate(true)
			setEventDelete(true)
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create webhook')
		}
	}

	const handleDelete = async (rkey: string) => {
		setDeletingRkey(rkey)
		try {
			await onDeleteWebhook(rkey)
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to delete webhook')
		} finally {
			setDeletingRkey(null)
		}
	}

	return (
		<div className="h-full flex flex-col border border-border/30 bg-card/50 font-mono">
			{/* Header */}
			<div className="p-4 pb-3 border-b border-border/30 flex-shrink-0">
				<p className="text-sm font-semibold">Webhooks</p>
				<p className="text-xs text-muted-foreground mt-0.5">Receive HTTP callbacks when AT Protocol records change</p>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">

				{/* Create form */}
				<form onSubmit={handleCreate} className="space-y-4">
					<p className="text-xs uppercase tracking-wider text-muted-foreground">Create Webhook</p>

					{/* URL */}
					<div className="space-y-1">
						<Label htmlFor="wh-url" className="text-xs text-muted-foreground">URL</Label>
						<Input
							id="wh-url"
							value={url}
							onChange={e => setUrl(e.target.value)}
							placeholder="https://example.com/webhook"
							required
							className="h-8 text-sm"
						/>
					</div>

					{/* App picker */}
					<div className="space-y-2">
						<Label className="text-xs text-muted-foreground">App</Label>
						<div className="flex flex-wrap gap-1.5">
							{APPS.map(app => (
								<button
									key={app.id}
									type="button"
									onClick={() => selectApp(app.id)}
									className={`px-3 py-1 text-xs border transition-colors ${
										selectedApp === app.id
											? 'border-accent bg-accent/20 text-foreground'
											: 'border-border/40 text-muted-foreground hover:border-border hover:text-foreground'
									}`}
								>
									{app.label}
								</button>
							))}
							<button
								type="button"
								onClick={() => selectApp('other')}
								className={`px-3 py-1 text-xs border transition-colors ${
									selectedApp === 'other'
										? 'border-accent bg-accent/20 text-foreground'
										: 'border-border/40 text-muted-foreground hover:border-border hover:text-foreground'
								}`}
							>
								Other
							</button>
						</div>
					</div>

					{/* Scope detail — known app */}
					{selectedApp && selectedApp !== 'other' && (
						<div className="space-y-1">
							<Label htmlFor="wh-path" className="text-xs text-muted-foreground">Collection / glob</Label>
							<div className="flex items-center gap-0 border border-border/40 focus-within:border-border">
								<span className="px-2 py-1.5 text-xs text-muted-foreground bg-muted/40 border-r border-border/40 whitespace-nowrap select-none">
									at://{userDid || 'did'}/
								</span>
								<input
									id="wh-path"
									value={scopePath}
									onChange={e => setScopePath(e.target.value)}
									placeholder="app.bsky.*"
									className="flex-1 px-2 py-1.5 text-xs bg-transparent outline-none font-mono"
								/>
							</div>
						</div>
					)}

					{/* Scope detail — other */}
					{selectedApp === 'other' && (
						<div className="space-y-2">
							<Label className="text-xs text-muted-foreground">Scope</Label>
							<div className="space-y-1.5">
								{([
									['all', 'All my records', `at://${userDid || 'did'}`],
									['collection', 'Specific collection', ''],
									['rkey', 'Specific record', ''],
								] as const).map(([mode, label, hint]) => (
									<label key={mode} className="flex items-start gap-2 cursor-pointer group">
										<input
											type="radio"
											name="other-mode"
											checked={otherMode === mode}
											onChange={() => setOtherMode(mode)}
											className="mt-0.5 accent-accent"
										/>
										<div className="flex-1">
											<span className="text-xs">{label}</span>
											{hint && <span className="text-xs text-muted-foreground ml-2">{hint}</span>}
										</div>
									</label>
								))}
							</div>
							{otherMode === 'collection' && (
								<Input
									value={otherCollection}
									onChange={e => setOtherCollection(e.target.value)}
									placeholder="app.bsky.feed.post"
									className="h-8 text-xs"
								/>
							)}
							{otherMode === 'rkey' && (
								<div className="flex gap-2">
									<Input
										value={otherCollection}
										onChange={e => setOtherCollection(e.target.value)}
										placeholder="collection"
										className="h-8 text-xs flex-1"
									/>
									<Input
										value={otherRkey}
										onChange={e => setOtherRkey(e.target.value)}
										placeholder="rkey"
										className="h-8 text-xs flex-1"
									/>
								</div>
							)}
						</div>
					)}

					{/* Wildcard hint */}
					{scopeAturi.includes('*') && (
						<p className="text-xs text-muted-foreground">
							<code className="bg-muted px-1">*</code> is a wildcard — matches any collection name at that level.
						</p>
					)}

					{/* Backlinks */}
					{selectedApp && (
						<div className="flex items-center gap-2">
							<Checkbox id="wh-backlinks" checked={backlinks} onCheckedChange={v => setBacklinks(!!v)} />
							<Label htmlFor="wh-backlinks" className="cursor-pointer text-xs">
								Backlinks <span className="text-muted-foreground">— also fire when other records reference this scope</span>
							</Label>
						</div>
					)}

					{/* Events */}
					{selectedApp && (
						<div className="space-y-1.5">
							<Label className="text-xs text-muted-foreground">Events</Label>
							<div className="flex gap-4">
								{([['create', eventCreate, setEventCreate], ['update', eventUpdate, setEventUpdate], ['delete', eventDelete, setEventDelete]] as const).map(([name, val, set]) => (
									<div key={name} className="flex items-center gap-1.5">
										<Checkbox id={`wh-event-${name}`} checked={val} onCheckedChange={v => set(!!v)} />
										<Label htmlFor={`wh-event-${name}`} className="cursor-pointer text-xs capitalize">{name}</Label>
									</div>
								))}
							</div>
							<p className="text-xs text-muted-foreground">All checked = no filter</p>
						</div>
					)}

					{error && <p className="text-xs text-destructive">{error}</p>}
					{success && <p className="text-xs text-green-500">{success}</p>}

					{selectedApp && (
						<Button type="submit" disabled={isCreating || !scopeAturi} size="sm">
							{isCreating ? <><Loader2 className="w-3 h-3 mr-2 animate-spin" />Creating...</> : 'Create Webhook'}
						</Button>
					)}
				</form>

				{/* Existing webhooks */}
				<div className="space-y-2">
					<p className="text-xs uppercase tracking-wider text-muted-foreground">Your Webhooks</p>
					{webhooksLoading ? (
						<div className="space-y-2">
							{[...Array(2)].map((_, i) => <SkeletonShimmer key={i} className="h-12 w-full" />)}
						</div>
					) : webhooks.length === 0 ? (
						<p className="text-xs text-muted-foreground py-1">No webhooks configured.</p>
					) : (
						<div className="space-y-1.5">
							{webhooks.map(wh => (
								<div key={wh.rkey} className="flex items-start justify-between p-3 border border-border/30 gap-4">
									<div className="space-y-0.5 min-w-0">
										<p className="text-xs truncate">{wh.url}</p>
										<p className="text-xs text-muted-foreground truncate">{wh.scopeAturi}</p>
										<div className="flex gap-1 flex-wrap mt-1">
											{!wh.enabled && <Badge variant="secondary" className="text-[10px]">disabled</Badge>}
											{wh.backlinks && <Badge variant="outline" className="text-[10px]">backlinks</Badge>}
											{wh.events.length > 0 && wh.events.map(e => <Badge key={e} variant="outline" className="text-[10px]">{e}</Badge>)}
										</div>
									</div>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => handleDelete(wh.rkey)}
										disabled={deletingRkey === wh.rkey}
										className="flex-shrink-0 h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
									>
										{deletingRkey === wh.rkey ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
									</Button>
								</div>
							))}
						</div>
					)}
				</div>

				{/* Event logs */}
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<p className="text-xs uppercase tracking-wider text-muted-foreground">
							Event Logs <span className="font-normal normal-case">(60s refresh)</span>
						</p>
						<Button variant="outline" size="sm" onClick={onRefreshEvents} disabled={eventLogsLoading} className="h-7 px-2 gap-1.5 text-xs">
							<RefreshCw className={`w-3 h-3 ${eventLogsLoading ? 'animate-spin' : ''}`} />
							Refresh
						</Button>
					</div>

					{eventLogsLoading ? (
						<div className="space-y-1.5">
							{[...Array(3)].map((_, i) => <SkeletonShimmer key={i} className="h-7 w-full" />)}
						</div>
					) : eventLogs.length === 0 ? (
						<p className="text-xs text-muted-foreground py-1">No events yet.</p>
					) : (
						<div className="overflow-x-auto border border-border/30">
							<table className="w-full text-xs font-mono border-collapse">
								<thead>
									<tr className="border-b border-border/30 text-muted-foreground bg-muted/20">
										<th className="text-left py-1.5 px-3">Time</th>
										<th className="text-left py-1.5 px-3">Status</th>
										<th className="text-left py-1.5 px-3">Event</th>
										<th className="text-left py-1.5 px-3">Source</th>
										<th className="text-left py-1.5 px-3">Collection</th>
										<th className="text-left py-1.5 px-3">Rkey</th>
										<th className="text-left py-1.5 px-3">Delivered To</th>
									</tr>
								</thead>
								<tbody>
									{eventLogs.map((log, i) => (
										<tr key={i} className="border-b border-border/20 hover:bg-muted/20">
											<td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">{new Date(log.deliveredAt).toLocaleTimeString()}</td>
											<td className="py-1.5 px-3">
												<Badge variant={log.status === 'ok' ? 'default' : 'destructive'} className="text-[10px]">{log.status}</Badge>
											</td>
											<td className="py-1.5 px-3">{log.eventKind}</td>
											<td className="py-1.5 px-3 truncate max-w-[8rem]">{log.eventDid}</td>
											<td className="py-1.5 px-3">{log.eventCollection}</td>
											<td className="py-1.5 px-3">{log.eventRkey}</td>
											<td className="py-1.5 px-3 truncate max-w-[8rem]">{log.url}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			</div>
		</div>
	)
}
