import { useState, useEffect } from 'react'
import { Button } from '@public/components/ui/button'
import { Input } from '@public/components/ui/input'
import { Checkbox } from '@public/components/ui/checkbox'
import { Label } from '@public/components/ui/label'
import { Badge } from '@public/components/ui/badge'
import { SkeletonShimmer } from '@public/components/ui/skeleton'
import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { WebhookRecord, WebhookEventLog } from '../hooks/useWebhookData'

interface WebhooksTabProps {
	webhooks: WebhookRecord[]
	webhooksLoading: boolean
	eventLogs: WebhookEventLog[]
	eventLogsLoading: boolean
	isCreating: boolean
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

export function WebhooksTab({
	webhooks,
	webhooksLoading,
	eventLogs,
	eventLogsLoading,
	isCreating,
	onCreateWebhook,
	onDeleteWebhook,
	onRefreshEvents,
}: WebhooksTabProps) {
	const [url, setUrl] = useState('')
	const [scopeAturi, setScopeAturi] = useState('')
	const [backlinks, setBacklinks] = useState(false)
	const [eventCreate, setEventCreate] = useState(true)
	const [eventUpdate, setEventUpdate] = useState(true)
	const [eventDelete, setEventDelete] = useState(true)
	const [secret, setSecret] = useState('')
	const [enabled, setEnabled] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [success, setSuccess] = useState<string | null>(null)
	const [deletingRkey, setDeletingRkey] = useState<string | null>(null)

	// Auto-refresh event logs every 60 seconds
	useEffect(() => {
		const id = setInterval(onRefreshEvents, 60_000)
		return () => clearInterval(id)
	}, [onRefreshEvents])

	const handleCreate = async (e: React.FormEvent) => {
		e.preventDefault()
		setError(null)
		setSuccess(null)

		if (!url.startsWith('http://') && !url.startsWith('https://')) {
			setError('URL must start with http:// or https://')
			return
		}
		if (!scopeAturi.startsWith('at://')) {
			setError('Scope must be a valid AT-URI (at://...)')
			return
		}

		const events: string[] = []
		if (eventCreate) events.push('create')
		if (eventUpdate) events.push('update')
		if (eventDelete) events.push('delete')

		try {
			await onCreateWebhook({ url, scopeAturi, backlinks, events: events.length === 3 ? [] : events, secret, enabled })
			setSuccess('Webhook created. It will become active once the service picks it up from the firehose.')
			setUrl('')
			setScopeAturi('')
			setBacklinks(false)
			setEventCreate(true)
			setEventUpdate(true)
			setEventDelete(true)
			setSecret('')
			setEnabled(true)
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

			{/* Content */}
			<div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">

				{/* Create webhook form */}
				<div className="space-y-3">
					<p className="text-xs uppercase tracking-wider text-muted-foreground">Create Webhook</p>
					<form onSubmit={handleCreate} className="space-y-3 p-3 border border-border/30">
						<div className="space-y-1">
							<Label htmlFor="wh-url" className="text-xs">URL <span className="text-muted-foreground">(required)</span></Label>
							<Input
								id="wh-url"
								value={url}
								onChange={e => setUrl(e.target.value)}
								placeholder="https://example.com/webhook"
								required
								className="h-8 text-sm"
							/>
						</div>

						<div className="space-y-1">
							<Label htmlFor="wh-scope" className="text-xs">Scope <span className="text-muted-foreground">(required)</span></Label>
							<Input
								id="wh-scope"
								value={scopeAturi}
								onChange={e => setScopeAturi(e.target.value)}
								placeholder="at://did:plc:... or at://did:plc:.../app.bsky.*"
								required
								className="h-8 text-sm"
							/>
							<p className="text-xs text-muted-foreground">
								<code className="bg-muted px-1">at://did</code> watches all records,{' '}
								<code className="bg-muted px-1">at://did/collection</code> for a specific one,{' '}
								<code className="bg-muted px-1">at://did/app.bsky.*</code> for a glob.
							</p>
						</div>

						<div className="flex items-center gap-2">
							<Checkbox id="wh-backlinks" checked={backlinks} onCheckedChange={v => setBacklinks(!!v)} />
							<Label htmlFor="wh-backlinks" className="cursor-pointer text-xs">
								Backlinks <span className="text-muted-foreground">— also fire when other records reference this scope</span>
							</Label>
						</div>

						<div className="space-y-1.5">
							<Label className="text-xs">Events</Label>
							<div className="flex gap-4">
								{([['create', eventCreate, setEventCreate], ['update', eventUpdate, setEventUpdate], ['delete', eventDelete, setEventDelete]] as const).map(([name, val, set]) => (
									<div key={name} className="flex items-center gap-1.5">
										<Checkbox id={`wh-event-${name}`} checked={val} onCheckedChange={v => set(!!v)} />
										<Label htmlFor={`wh-event-${name}`} className="cursor-pointer text-xs capitalize">{name}</Label>
									</div>
								))}
							</div>
							<p className="text-xs text-muted-foreground">All checked = no filter (fires on all events)</p>
						</div>

						<div className="space-y-1">
							<Label htmlFor="wh-secret" className="text-xs">Secret <span className="text-muted-foreground">(optional)</span></Label>
							<Input
								id="wh-secret"
								type="password"
								value={secret}
								onChange={e => setSecret(e.target.value)}
								placeholder="HMAC-SHA256 signing secret"
								className="h-8 text-sm"
							/>
							<p className="text-xs text-muted-foreground">Stored publicly in your PDS record — transport integrity, not authentication.</p>
						</div>

						<div className="flex items-center gap-2">
							<Checkbox id="wh-enabled" checked={enabled} onCheckedChange={v => setEnabled(!!v)} />
							<Label htmlFor="wh-enabled" className="cursor-pointer text-xs">Enabled</Label>
						</div>

						{error && <p className="text-xs text-destructive">{error}</p>}
						{success && <p className="text-xs text-green-500">{success}</p>}

						<Button type="submit" disabled={isCreating} size="sm" className="w-full sm:w-auto">
							{isCreating ? <><Loader2 className="w-3 h-3 mr-2 animate-spin" />Creating...</> : 'Create Webhook'}
						</Button>
					</form>
				</div>

				{/* Existing webhooks */}
				<div className="space-y-2">
					<p className="text-xs uppercase tracking-wider text-muted-foreground">Your Webhooks</p>
					{webhooksLoading ? (
						<div className="space-y-2">
							{[...Array(2)].map((_, i) => <SkeletonShimmer key={i} className="h-14 w-full" />)}
						</div>
					) : webhooks.length === 0 ? (
						<p className="text-xs text-muted-foreground py-2">No webhooks configured.</p>
					) : (
						<div className="space-y-2">
							{webhooks.map(wh => (
								<div key={wh.rkey} className="flex items-start justify-between p-3 border border-border/30 gap-4">
									<div className="space-y-1 min-w-0">
										<p className="text-sm truncate">{wh.url}</p>
										<p className="text-xs text-muted-foreground truncate">{wh.scopeAturi}</p>
										<div className="flex gap-1.5 flex-wrap">
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
							Event Logs <span className="font-normal normal-case">(auto-refreshes every 60s)</span>
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
						<p className="text-xs text-muted-foreground py-2">No events yet.</p>
					) : (
						<div className="overflow-x-auto border border-border/30">
							<table className="w-full text-xs font-mono border-collapse">
								<thead>
									<tr className="border-b border-border/30 text-muted-foreground bg-muted/20">
										<th className="text-left py-2 px-3">Time</th>
										<th className="text-left py-2 px-3">Status</th>
										<th className="text-left py-2 px-3">Event</th>
										<th className="text-left py-2 px-3">Source DID</th>
										<th className="text-left py-2 px-3">Collection</th>
										<th className="text-left py-2 px-3">Rkey</th>
										<th className="text-left py-2 px-3">Delivered To</th>
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
											<td className="py-1.5 px-3 truncate max-w-[10rem]">{log.eventDid}</td>
											<td className="py-1.5 px-3">{log.eventCollection}</td>
											<td className="py-1.5 px-3">{log.eventRkey}</td>
											<td className="py-1.5 px-3 truncate max-w-[10rem]">{log.url}</td>
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
