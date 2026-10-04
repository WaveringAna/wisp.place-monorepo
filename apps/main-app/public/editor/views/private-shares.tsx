import { type FormEvent, useState } from 'react'
import { api } from '../api'
import { confirmAction } from '../confirm'
import { expiresIn, timeAgo } from '../format'
import { keys, useAction, useShares } from '../queries'
import { Button, CopyButton, Notice, Tag, TextField } from '../ui'

const statusTone = { active: 'mint', expired: 'butter', revoked: 'pink' } as const

async function resolveAudience(account: string): Promise<string | undefined> {
	const handle = account.trim().replace(/^@/, '')
	if (!handle) return undefined
	const result = await api.resolveHandle(handle)
	if (!result.found || !result.did) throw new Error(`no account found for @${handle}`)
	return result.did
}

export function PrivateShares({ siteId }: { siteId: string }) {
	const shares = useShares(siteId)
	const [created, setCreated] = useState<string | null>(null)

	const create = useAction(
		async ({ label, account }: { label: string; account: string }) => {
			const audienceDid = await resolveAudience(account)
			return api.createShare(siteId, {
				...(label.trim() ? { label: label.trim() } : {}),
				...(audienceDid ? { audienceDid } : {}),
			})
		},
		{ invalidates: [keys.shares(siteId), keys.sites], failure: 'could not create share link' },
	)

	const revoke = useAction((shareId: string) => api.revokeShare(siteId, shareId), {
		invalidates: [keys.shares(siteId), keys.sites],
		success: 'share link revoked',
		failure: 'could not revoke share link',
	})

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const form = event.currentTarget
		const data = new FormData(form)
		create.mutate(
			{ label: String(data.get('label') ?? ''), account: String(data.get('account') ?? '') },
			{
				onSuccess: ({ url }) => {
					setCreated(url)
					form.reset()
				},
			},
		)
	}

	const askRevoke = async (shareId: string, prefix: string) => {
		const confirmed = await confirmAction({
			title: `revoke ${prefix}…?`,
			body: 'Anyone holding this link loses access immediately.',
			action: 'revoke',
		})
		if (confirmed) revoke.mutate(shareId)
	}

	return (
		<div className="mt-4">
			<h3 className="mb-2 text-xs text-ink-soft">share links</h3>
			{created && (
				<Notice>
					copy it now, it is shown only once: <code className="break-all text-ink">{created}</code>{' '}
					<CopyButton text={created} />
				</Notice>
			)}
			<form onSubmit={submit} className="mb-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
				<TextField label="label" name="label" placeholder="optional" autoComplete="off" />
				<TextField
					label="only for account"
					name="account"
					placeholder="alice.bsky.social (blank = anyone)"
					autoCapitalize="none"
					autoComplete="off"
					spellCheck={false}
				/>
				<Button type="submit" busy={create.isPending}>
					new link
				</Button>
			</form>
			{shares.isSuccess && shares.data.length === 0 && <p className="text-xs text-ink-soft">no share links yet</p>}
			<ul className="space-y-1">
				{shares.data?.map((share) => (
					<li key={share.shareId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
						<Tag tone={statusTone[share.status]}>{share.status}</Tag>
						<code>{share.tokenPrefix}…</code>
						{share.label && <span className="text-ink">{share.label}</span>}
						{share.audienceDid && <span className="truncate text-ink-soft">only {share.audienceDid}</span>}
						<span className="text-ink-soft">
							{share.status === 'active' && expiresIn(share.expiresAt)}
							{share.lastUsedAt && ` · used ${timeAgo(share.lastUsedAt)}`}
						</span>
						{share.status === 'active' && (
							<Button
								variant="danger"
								className="ml-auto"
								busy={revoke.isPending && revoke.variables === share.shareId}
								onClick={() => askRevoke(share.shareId, share.tokenPrefix)}
							>
								revoke
							</Button>
						)}
					</li>
				))}
			</ul>
		</div>
	)
}
