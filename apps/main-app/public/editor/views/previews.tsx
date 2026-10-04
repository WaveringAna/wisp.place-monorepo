import { type FormEvent, useId, useState } from 'react'
import { ApiError, api, type PreviewRepo, type PreviewsInfo, type UserInfo } from '../api'
import { confirmAction } from '../confirm'
import { plural } from '../format'
import { type RowProps, useRovingList } from '../keys'
import { keys, useAction, usePreviews } from '../queries'
import { previewWorkflow } from '../recipes'
import {
	Button,
	CodeBlock,
	CopyButton,
	Dialog,
	Empty,
	ExternalLink,
	Notice,
	Section,
	SelectField,
	SkeletonRows,
	Tag,
	TextField,
} from '../ui'

const WORKFLOW_PATH = '.tangled/workflows/preview.yml'

const REFUSALS: Record<string, string> = {
	'unknown-repo': 'that repo is not in your account any more',
	'no-spindle': 'this repo has no spindle, so nothing would build its pull requests',
	'claim-not-owned': 'that subdomain is not yours',
	'needs-ci-permission': 'wisp needs the tangled ci permission first',
	'bad-app-password':
		'that is not a working app password for your account (the account password is refused on purpose)',
	'secret-failed': 'the spindle would not take the secret, try again',
}

const refusalText = (error: unknown) =>
	error instanceof ApiError ? (REFUSALS[error.message] ?? error.message) : 'unknown error'

export function PreviewsSection({ user }: { user: UserInfo | undefined }) {
	const previews = usePreviews()
	const [expanded, setExpanded] = useState<string | null>(null)
	const [connecting, setConnecting] = useState(false)
	const info = previews.data
	const repos = info?.repos ?? []
	const enabled = repos.filter((repo) => repo.preview).length
	const rowProps = useRovingList(repos.length)

	return (
		<Section
			title="pull-request previews"
			meta={info && `${plural(enabled, 'repo')} on`}
			actions={
				info?.previewHost &&
				!info.canSetSecrets && (
					<Button variant="primary" onClick={() => setConnecting(true)}>
						connect tangled ci
					</Button>
				)
			}
		>
			<p className="hint my-2">
				pick a repo and every pull request gets its own live site, with a comment linking to it.
			</p>
			{previews.isPending && <SkeletonRows count={3} />}
			{previews.isError && <Notice tone="bad">could not load your tangled repos: {previews.error.message}</Notice>}
			{info && !info.previewHost && <Notice tone="warn">previews are turned off on this wisp.place deployment</Notice>}
			{info?.previewHost && repos.length === 0 && <Empty>no tangled repos on your account yet ✦</Empty>}
			{info?.previewHost && (
				<ul className="rows">
					{repos.map((repo, index) => (
						<PreviewRow
							key={repo.rkey}
							repo={repo}
							info={info}
							user={user}
							expanded={expanded === repo.rkey}
							onToggle={() => setExpanded((current) => (current === repo.rkey ? null : repo.rkey))}
							onConnect={() => setConnecting(true)}
							rowProps={rowProps(index)}
						/>
					))}
				</ul>
			)}
			<ConnectCiDialog open={connecting} onClose={() => setConnecting(false)} />
		</Section>
	)
}

interface PreviewRowProps {
	repo: PreviewRepo
	info: PreviewsInfo
	user: UserInfo | undefined
	expanded: boolean
	onToggle: () => void
	onConnect: () => void
	rowProps: RowProps
}

function PreviewRow({ repo, info, user, expanded, onToggle, onConnect, rowProps }: PreviewRowProps) {
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
				<span className={repo.preview ? 'text-ok' : 'text-ink-soft'} aria-hidden="true">
					{repo.preview ? '●' : '○'}
				</span>
				<span className="min-w-0 flex-1 truncate font-bold">{repo.name}</span>
				<span className="truncate text-ink-soft max-sm:basis-full">{repo.spindle ?? 'no spindle'}</span>
				{repo.preview && <Tag tone="mint">previews · {repo.preview.claim}</Tag>}
				{repo.preview && repo.secret === 'missing' && <Tag tone="butter">no deploy secret</Tag>}
			</button>
			{expanded && (
				<div id={detailId} className="row-detail">
					{repo.blocked ? (
						<Notice tone="warn">
							this repo has no spindle, so nothing builds its pull requests. pick one in the repo&apos;s settings on
							tangled, then come back.
						</Notice>
					) : (
						<PreviewSetup repo={repo} info={info} user={user} onConnect={onConnect} />
					)}
				</div>
			)}
		</li>
	)
}

interface PreviewSetupProps {
	repo: PreviewRepo
	info: PreviewsInfo
	user: UserInfo | undefined
	onConnect: () => void
}

function PreviewSetup({ repo, info, user, onConnect }: PreviewSetupProps) {
	const [claim, setClaim] = useState(repo.preview?.claim ?? info.claims[0] ?? '')
	const [password, setPassword] = useState('')
	const [branch, setBranch] = useState('main')
	const [build, setBuild] = useState('')
	const [path, setPath] = useState('./dist')
	const needsPassword = !repo.preview && repo.secret !== 'set'

	const enable = useAction((input: { claim: string; appPassword?: string }) => api.enablePreview(repo.name, input), {
		invalidates: [keys.previews],
		success: `previews on for ${repo.name}`,
		failure: 'could not turn previews on',
	})
	const disable = useAction(() => api.disablePreview(repo.name), {
		invalidates: [keys.previews],
		success: `previews off for ${repo.name}`,
		failure: 'could not turn previews off',
	})

	const submit = (event: FormEvent) => {
		event.preventDefault()
		enable.mutate({ claim, ...(password ? { appPassword: password } : {}) }, { onSuccess: () => setPassword('') })
	}

	const askDisable = async () => {
		const confirmed = await confirmAction({
			title: `turn previews off for ${repo.name}?`,
			body: 'pull requests stop getting preview comments. the deploy secret and earlier previews stay where they are.',
			action: 'turn off',
		})
		if (confirmed) disable.mutate(undefined)
	}

	if (info.claims.length === 0) {
		return (
			<Notice tone="warn">previews live under one of your wisp subdomains: claim one on the domains tab first</Notice>
		)
	}

	const workflow = previewWorkflow({
		handle: user?.handle ?? 'your-handle',
		claim: repo.preview?.claim ?? claim,
		previewHost: info.previewHost ?? '',
		branch,
		build,
		path,
	})

	return (
		<div className="space-y-6">
			<form onSubmit={submit} className="space-y-3">
				<p className="field-label">1 · {repo.preview ? 'previews are on' : 'turn previews on'}</p>
				<div className="grid gap-3 sm:grid-cols-2">
					<SelectField
						label="preview urls under"
						value={claim}
						onChange={(event) => setClaim(event.target.value)}
						hint={`pr-<commit>-${claim}.${info.previewHost}`}
					>
						{info.claims.map((label) => (
							<option key={label} value={label}>
								{label}
							</option>
						))}
					</SelectField>
					{info.canSetSecrets ? (
						<TextField
							label="app password for the workflow"
							type="password"
							autoComplete="off"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							required={needsPassword}
							placeholder={repo.secret === 'set' ? 'leave empty to keep the current one' : 'xxxx-xxxx-xxxx-xxxx'}
							hint="make one in your account's app-password settings. it goes straight to the spindle as WISP_APP_PASSWORD; wisp keeps no copy."
						/>
					) : (
						<div>
							<p className="field-label">deploy secret</p>
							<p className="hint mb-2">
								wisp needs one more permission to store it for you. or add WISP_APP_PASSWORD to the repo&apos;s spindle
								secrets on tangled yourself and turn previews on here.
							</p>
							<Button onClick={onConnect}>connect tangled ci</Button>
						</div>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button type="submit" variant="primary" busy={enable.isPending}>
						{repo.preview ? 'save' : 'turn previews on'}
					</Button>
					{repo.preview && (
						<Button variant="danger" busy={disable.isPending} onClick={askDisable}>
							turn off
						</Button>
					)}
					{enable.isError && <span className="text-xs text-bad">{refusalText(enable.error)}</span>}
				</div>
			</form>

			<div className="space-y-3">
				<p className="field-label">2 · add the workflow</p>
				<div className="grid gap-3 sm:grid-cols-3">
					<TextField label="pull requests into" value={branch} onChange={(event) => setBranch(event.target.value)} />
					<TextField
						label="build command"
						value={build}
						onChange={(event) => setBuild(event.target.value)}
						placeholder="none, the site is already static"
					/>
					<TextField label="site directory" value={path} onChange={(event) => setPath(event.target.value)} />
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<code className="text-xs">{WORKFLOW_PATH}</code>
					<CopyButton text={workflow} label="copy workflow" />
					{user && (
						<ExternalLink href={`https://tangled.org/${user.handle}/${repo.name}`} className="text-xs">
							open {repo.name} on tangled
						</ExternalLink>
					)}
				</div>
				<CodeBlock code={workflow} />
				<p className="hint">
					add anything the build needs under dependencies. pull requests from forks build without the secret, so they
					skip the deploy.
				</p>
			</div>
		</div>
	)
}

function ConnectCiDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	return (
		<Dialog
			open={open}
			onClose={onClose}
			title="connect tangled ci"
			footer={
				<>
					<Button variant="primary" data-autofocus onClick={() => window.location.assign('/api/auth/setup/ci')}>
						sign in again
					</Button>
					<Button variant="ghost" onClick={onClose}>
						not now
					</Button>
				</>
			}
		>
			<div className="space-y-3 text-sm">
				<p>
					previews deploy from your spindle with an app password, kept there as the secret{' '}
					<code>WISP_APP_PASSWORD</code>. so wisp can put it there for you, it needs one more permission:
				</p>
				<ul className="list-disc space-y-1 pl-5">
					<li>
						<strong>add secrets to your repos on tangled spindles</strong> (<code>sh.tangled.repo.addSecret</code>)
					</li>
					<li>
						<strong>see which secrets a repo has</strong>, names only (<code>sh.tangled.repo.listSecrets</code>), so
						this page can tell you it is set
					</li>
				</ul>
				<p>
					you&apos;ll sign in again and your PDS will show the new request. wisp only uses it when you set a repo up
					here. the app password goes straight to the spindle; wisp checks it once and keeps no copy. secret values
					can&apos;t be read back by anyone, wisp included.
				</p>
				<p className="hint">
					next time you sign in normally wisp asks for the usual permissions only, and this page will offer to connect
					again when you need it.
				</p>
			</div>
		</Dialog>
	)
}
