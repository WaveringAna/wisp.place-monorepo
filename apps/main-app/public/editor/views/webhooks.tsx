import { type FormEvent, useId, useState } from 'react'
import { api, type UserInfo, type WebhookEvent, type WebhookInput } from '../api'
import { confirmAction } from '../confirm'
import { plural } from '../format'
import { type RowProps, rowActions, useRovingList } from '../keys'
import {
	ALL_WEBHOOK_EVENTS,
	buildScope,
	eventsFilter,
	type OtherScope,
	type ScopeDraft,
	scopePath,
	WEBHOOK_APPS,
	type Webhook,
} from '../model'
import { keys, useAction, useSecrets, useWebhooks } from '../queries'
import {
	Button,
	Dialog,
	Empty,
	Notice,
	Section,
	Segmented,
	SelectField,
	SkeletonRows,
	Tag,
	TextField,
	Toggle,
} from '../ui'
import { canUseLocalLoopbackWebhookHttp, validateEditorWebhookEndpointUrl } from '../webhook-url-policy'
import { Deliveries } from './deliveries'
import { Secrets } from './secrets'

export function WebhooksView({ user }: { user: UserInfo | undefined }) {
	const webhooks = useWebhooks()
	const [creating, setCreating] = useState(false)
	const [expanded, setExpanded] = useState<string | null>(null)
	const list = webhooks.data ?? []

	const remove = useAction((webhook: Webhook) => api.deleteWebhook(webhook.rkey), {
		invalidates: [keys.webhooks],
		success: 'webhook deleted',
		failure: 'could not delete webhook',
	})

	const askRemove = async (webhook: Webhook) => {
		const confirmed = await confirmAction({
			title: 'delete this webhook?',
			body: `${webhook.url} stops receiving events.`,
			action: 'delete',
		})
		if (confirmed) remove.mutate(webhook)
	}

	const rowProps = useRovingList(list.length, rowActions(list, { d: askRemove }))

	return (
		<>
			<Section
				title="webhooks"
				meta={webhooks.data && plural(list.length, 'webhook')}
				actions={
					<Button variant="primary" onClick={() => setCreating(true)} hotkey="n">
						+ new
					</Button>
				}
			>
				<p className="hint my-2">
					get an http callback when records change in your repo, or when other repos reference them
				</p>
				{webhooks.isPending && <SkeletonRows count={2} />}
				{webhooks.isError && <Notice tone="bad">could not load webhooks: {webhooks.error.message}</Notice>}
				{webhooks.isSuccess && list.length === 0 && <Empty>no webhooks yet ✦</Empty>}
				<ul className="rows">
					{list.map((webhook, index) => (
						<WebhookRow
							key={webhook.rkey}
							webhook={webhook}
							expanded={expanded === webhook.rkey}
							onToggle={() => setExpanded((current) => (current === webhook.rkey ? null : webhook.rkey))}
							rowProps={rowProps(index)}
							deleting={remove.isPending && remove.variables?.rkey === webhook.rkey}
							onDelete={() => askRemove(webhook)}
						/>
					))}
				</ul>
			</Section>
			<Secrets />
			<Deliveries />
			<CreateWebhookDialog open={creating} did={user?.did ?? ''} onClose={() => setCreating(false)} />
		</>
	)
}

interface WebhookRowProps {
	webhook: Webhook
	expanded: boolean
	onToggle: () => void
	rowProps: RowProps
	deleting: boolean
	onDelete: () => void
}

function WebhookRow({ webhook, expanded, onToggle, rowProps, deleting, onDelete }: WebhookRowProps) {
	const detailId = useId()
	return (
		<li>
			<button
				type="button"
				{...rowProps}
				className="row-line flex-wrap"
				aria-expanded={expanded}
				aria-controls={detailId}
				onClick={onToggle}
			>
				<span className={webhook.enabled ? 'text-ok' : 'text-ink-soft'} aria-hidden="true">
					{webhook.enabled ? '●' : '○'}
				</span>
				<span className="min-w-0 flex-1 truncate font-bold">{webhook.url}</span>
				<span className="truncate text-ink-soft max-sm:basis-full">{scopePath(webhook.scope)}</span>
				{webhook.backlinksOnly ? (
					<Tag tone="lilac">backlinks only</Tag>
				) : (
					webhook.backlinks && <Tag tone="lilac">+ backlinks</Tag>
				)}
				{webhook.secretId && <Tag tone="mint">signed</Tag>}
			</button>
			{expanded && (
				<div id={detailId} className="row-detail">
					<dl className="kv">
						<dt>endpoint</dt>
						<dd className="break-all">{webhook.url}</dd>
						<dt>scope</dt>
						<dd className="break-all">{webhook.scope}</dd>
						<dt>events</dt>
						<dd>{webhook.events.length ? webhook.events.join(' · ') : 'create · update · delete'}</dd>
						<dt>signed with</dt>
						<dd>{webhook.secretId ?? <span className="text-ink-soft">unsigned</span>}</dd>
						{!webhook.enabled && (
							<>
								<dt>state</dt>
								<dd>disabled</dd>
							</>
						)}
					</dl>
					<Button variant="danger" className="mt-3" busy={deleting} onClick={onDelete} shortcut="d">
						delete
					</Button>
				</div>
			)}
		</li>
	)
}

function CreateWebhookDialog({ open, did, onClose }: { open: boolean; did: string; onClose: () => void }) {
	const formId = useId()
	const create = useAction(api.createWebhook, {
		invalidates: [keys.webhooks],
		success: 'webhook created ✦',
		failure: 'could not create webhook',
	})

	return (
		<Dialog
			open={open}
			onClose={onClose}
			title="new webhook"
			footer={
				<>
					<Button variant="ghost" className="ml-auto" onClick={onClose}>
						cancel
					</Button>
					<Button variant="primary" type="submit" form={formId} busy={create.isPending}>
						create
					</Button>
				</>
			}
		>
			<WebhookForm id={formId} did={did} onSubmit={(input) => create.mutate(input, { onSuccess: onClose })} />
		</Dialog>
	)
}

const OTHER_SCOPES: { value: OtherScope; label: string }[] = [
	{ value: 'all', label: 'every record' },
	{ value: 'collection', label: 'one collection' },
	{ value: 'record', label: 'one record' },
]

function WebhookForm({ id, did, onSubmit }: { id: string; did: string; onSubmit: (input: WebhookInput) => void }) {
	const secrets = useSecrets()
	const [scope, setScope] = useState<ScopeDraft>({
		did: '',
		app: null,
		path: '',
		other: 'all',
		collection: '',
		rkey: '',
	})
	const [otherRepo, setOtherRepo] = useState(false)
	const [events, setEvents] = useState<readonly WebhookEvent[]>(ALL_WEBHOOK_EVENTS)
	const [backlinks, setBacklinks] = useState(false)
	const [backlinksOnly, setBacklinksOnly] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const patch = (change: Partial<ScopeDraft>) => setScope((previous) => ({ ...previous, ...change }))
	const scopeAturi = buildScope({ ...scope, did: otherRepo ? scope.did.trim() : did })

	const toggleEvent = (event: WebhookEvent, on: boolean) =>
		setEvents((previous) => ALL_WEBHOOK_EVENTS.filter((name) => (name === event ? on : previous.includes(name))))

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const form = new FormData(event.currentTarget)
		const url = String(form.get('url') ?? '').trim()
		const secretId = String(form.get('secret') ?? '')
		const endpoint = validateEditorWebhookEndpointUrl(url, {
			allowLoopbackDev: canUseLocalLoopbackWebhookHttp(window.location.href),
		})
		if (!endpoint.ok) return setError(endpoint.error)
		if (!scopeAturi) return setError('pick what to watch')
		if (events.length === 0) return setError('pick at least one event')
		setError(null)
		onSubmit({
			url,
			scopeAturi,
			backlinks: backlinks || backlinksOnly,
			...(backlinksOnly ? { backlinksOnly: true } : {}),
			events: eventsFilter(events),
			...(secretId ? { secretId } : {}),
			enabled: true,
		})
	}

	return (
		<form id={id} onSubmit={submit} className="space-y-4">
			<TextField
				label="endpoint url"
				hint="https only; plain http works for a loopback endpoint during local development"
				name="url"
				type="url"
				required
				maxLength={2048}
				placeholder="https://example.com/webhook"
				spellCheck={false}
				data-autofocus
			/>

			<div>
				<span className="field-label">watch</span>
				<Segmented
					label="app to watch"
					options={WEBHOOK_APPS.map((app) => ({ value: app.id, label: app.label }))}
					value={scope.app}
					onChange={(app) => patch({ app, path: WEBHOOK_APPS.find((entry) => entry.id === app)?.path ?? '' })}
				/>
			</div>

			{scope.app && scope.app !== 'other' && (
				<TextField
					label="collection or glob"
					hint="* matches any collection name at that level"
					value={scope.path}
					onChange={(event) => patch({ path: event.target.value })}
					spellCheck={false}
				/>
			)}

			{scope.app === 'other' && (
				<div className="space-y-2">
					<Segmented label="scope" options={OTHER_SCOPES} value={scope.other} onChange={(other) => patch({ other })} />
					{scope.other !== 'all' && (
						<div className="flex gap-2">
							<TextField
								label="collection"
								className="flex-1"
								value={scope.collection}
								onChange={(event) => patch({ collection: event.target.value })}
								placeholder="app.bsky.feed.post"
								spellCheck={false}
							/>
							{scope.other === 'record' && (
								<TextField
									label="record key"
									className="flex-1"
									value={scope.rkey}
									onChange={(event) => patch({ rkey: event.target.value })}
									spellCheck={false}
								/>
							)}
						</div>
					)}
				</div>
			)}

			<Toggle
				className="flex"
				checked={otherRepo}
				onChange={(event) => setOtherRepo(event.target.checked)}
				label="watch someone else's repo"
				hint="defaults to your own did"
			/>
			{otherRepo && (
				<TextField
					label="did"
					className="ml-9"
					value={scope.did}
					onChange={(event) => patch({ did: event.target.value })}
					placeholder="did:plc:…"
				/>
			)}

			<p className="break-all text-xs">
				<span className="text-ink-soft">scope → </span>
				<span className="text-rose">{scopeAturi || '…'}</span>
			</p>

			<fieldset className="flex flex-wrap gap-x-5 gap-y-1">
				<legend className="field-label">events</legend>
				{ALL_WEBHOOK_EVENTS.map((name) => (
					<Toggle
						key={name}
						label={name}
						checked={events.includes(name)}
						onChange={(event) => toggleEvent(name, event.target.checked)}
					/>
				))}
			</fieldset>

			<div className="space-y-1">
				<Toggle
					className="flex"
					checked={backlinks || backlinksOnly}
					disabled={backlinksOnly}
					onChange={(event) => setBacklinks(event.target.checked)}
					label="backlinks"
					hint="also fire when other repos reference these records"
				/>
				<Toggle
					className="flex"
					checked={backlinksOnly}
					onChange={(event) => setBacklinksOnly(event.target.checked)}
					label="backlinks only"
					hint="only references from other repos, never changes to the records themselves"
				/>
			</div>

			<SelectField
				label="signing secret"
				hint={secrets.data?.length === 0 ? 'create one under signing secrets to sign deliveries' : undefined}
				name="secret"
				defaultValue=""
			>
				<option value="">none</option>
				{secrets.data?.map((secret) => (
					<option key={secret.name} value={secret.name}>
						{secret.name}
					</option>
				))}
			</SelectField>

			{error && <Notice tone="bad">{error}</Notice>}
		</form>
	)
}
