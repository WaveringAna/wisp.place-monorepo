import { type FormEvent, useId, useState } from 'react'
import { api, type SecretMeta } from '../api'
import { confirmAction } from '../confirm'
import { plural, timeAgo } from '../format'
import { type RowProps, rowActions, useRovingList } from '../keys'
import { keys, useAction, useSecrets, useWebhooks } from '../queries'
import {
	AddLabel,
	Button,
	CHEVRON,
	type Column,
	CopyButton,
	DetailRow,
	Notice,
	Row,
	Section,
	Sheet,
	SkeletonRows,
	TextField,
} from '../ui'

const COLUMNS: readonly Column[] = [
	CHEVRON,
	{ name: 'name' },
	{ name: 'signs', className: 'max-sm:hidden' },
	{ name: 'created', align: 'right', className: 'max-sm:hidden' },
	{ name: 'rotated', align: 'right' },
]

export function Secrets() {
	const secrets = useSecrets()
	const webhooks = useWebhooks()
	const [expanded, setExpanded] = useState<string | null>(null)
	const [revealed, setRevealed] = useState<{ name: string; token: string } | null>(null)
	const list = secrets.data ?? []

	const reveal =
		(name: string) =>
		({ token }: { token: string }) =>
			setRevealed({ name, token })

	const create = useAction(api.createSecret, {
		invalidates: [keys.secrets],
		success: (_, name) => `created ${name}`,
		failure: 'could not create secret',
	})
	const rotate = useAction((secret: SecretMeta) => api.rotateSecret(secret.name), {
		invalidates: [keys.secrets],
		success: (_, secret) => `rotated ${secret.name}`,
		failure: 'could not rotate secret',
	})
	const remove = useAction((secret: SecretMeta) => api.deleteSecret(secret.name), {
		invalidates: [keys.secrets],
		success: (_, secret) => `deleted ${secret.name}`,
		failure: 'could not delete secret',
	})

	const askRotate = async (secret: SecretMeta) => {
		const confirmed = await confirmAction({
			title: `rotate ${secret.name}?`,
			body: 'The old token stops verifying deliveries as soon as the new one is issued.',
			action: 'rotate',
		})
		if (confirmed) rotate.mutate(secret, { onSuccess: reveal(secret.name) })
	}

	const askRemove = async (secret: SecretMeta) => {
		const confirmed = await confirmAction({
			title: `delete ${secret.name}?`,
			body: 'Webhooks signed with it start sending unsigned deliveries.',
			action: 'delete',
		})
		if (confirmed) remove.mutate(secret)
	}

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const form = event.currentTarget
		const name = String(new FormData(form).get('name') ?? '').trim()
		create.mutate(name, {
			onSuccess: (result) => {
				reveal(name)(result)
				form.reset()
			},
		})
	}

	const rowProps = useRovingList(list.length, rowActions(list, { r: askRotate, d: askRemove }))

	return (
		<Section title="signing secrets" meta="deliveries carry an hmac signature your endpoint can check">
			{revealed && (
				<Notice>
					token for <strong className="text-ink">{revealed.name}</strong>, copy it now, it will not be shown again:{' '}
					<code className="break-all text-ink">{revealed.token}</code> <CopyButton text={revealed.token} />
				</Notice>
			)}
			{secrets.isPending && <SkeletonRows count={1} />}
			{secrets.isSuccess && (
				<Sheet
					columns={COLUMNS}
					form={
						<form onSubmit={submit} className="contents">
							<TextField
								label={<AddLabel>new secret</AddLabel>}
								className="field"
								name="name"
								required
								maxLength={64}
								pattern="[A-Za-z0-9._\-]+"
								title="1–64 letters, digits, dots, underscores or hyphens"
								placeholder="my-server"
								autoComplete="off"
								spellCheck={false}
							/>
							<Button variant="primary" type="submit" busy={create.isPending}>
								create
							</Button>
						</form>
					}
				>
					{list.map((secret, index) => (
						<SecretRow
							key={secret.name}
							secret={secret}
							usedBy={(webhooks.data ?? [])
								.filter((webhook) => webhook.secretId === secret.name)
								.map((webhook) => webhook.url)}
							expanded={expanded === secret.name}
							onToggle={() => setExpanded((current) => (current === secret.name ? null : secret.name))}
							rowProps={rowProps(index)}
							rotating={rotate.isPending && rotate.variables?.name === secret.name}
							deleting={remove.isPending && remove.variables?.name === secret.name}
							onRotate={() => askRotate(secret)}
							onDelete={() => askRemove(secret)}
						/>
					))}
				</Sheet>
			)}
		</Section>
	)
}

interface SecretRowProps {
	secret: SecretMeta
	usedBy: string[]
	expanded: boolean
	onToggle: () => void
	rowProps: RowProps
	rotating: boolean
	deleting: boolean
	onRotate: () => void
	onDelete: () => void
}

function SecretRow({
	secret,
	usedBy,
	expanded,
	onToggle,
	rowProps,
	rotating,
	deleting,
	onRotate,
	onDelete,
}: SecretRowProps) {
	const detailId = useId()
	return (
		<>
			<Row rowProps={rowProps} onActivate={onToggle} expanded={expanded} controls={detailId}>
				<td className="chev" />
				<td className="name max-w-0 truncate">{secret.name}</td>
				<td className="max-sm:hidden">{usedBy.length ? plural(usedBy.length, 'webhook') : '—'}</td>
				<td className="num whitespace-nowrap text-xs max-sm:hidden">{timeAgo(secret.createdAt)}</td>
				<td className="num whitespace-nowrap text-xs">{secret.lastRotatedAt ? timeAgo(secret.lastRotatedAt) : '—'}</td>
			</Row>
			{expanded && (
				<DetailRow id={detailId} span={COLUMNS.length}>
					<dl className="detail-grid">
						<div>
							<dt>signs</dt>
							<dd>
								{usedBy.length === 0 && <span className="text-ink-soft">no webhooks yet</span>}
								{usedBy.map((url) => (
									<span key={url} className="block break-all">
										{url}
									</span>
								))}
							</dd>
						</div>
						<div>
							<dt>created</dt>
							<dd>{new Date(secret.createdAt).toLocaleString()}</dd>
						</div>
					</dl>
					<div className="mt-4 flex gap-2">
						<Button busy={rotating} onClick={onRotate} shortcut="r">
							rotate
						</Button>
						<Button variant="danger" busy={deleting} onClick={onDelete} shortcut="d">
							delete
						</Button>
					</div>
				</DetailRow>
			)}
		</>
	)
}
