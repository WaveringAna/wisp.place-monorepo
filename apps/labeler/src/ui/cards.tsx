import { memo, useState } from 'react'
import type { ActiveLabel, ModerationEvent, SiteSummary, Verdict, VerdictRecord } from '../moderation/types'
import { VERDICTS } from '../moderation/types'
import { actorName, ago, describeEvent, eventSubject, isDid, labelName, parseSiteUri } from './format'
import { formatRoute } from './route'

export type CardActions = {
	focus: (uri: string) => void
	verdict: (subject: string, verdict: Verdict, note: string) => void
	label: (subject: string, val: '!takedown' | '!hide', neg: boolean, note: string) => void
	takedown: (subject: string, what: string) => void
	togglePreview: (uri: string) => void
}

const VERDICT_KEYS: Record<Verdict, string> = { fine: 'f', empty: 'e', 'mass-created': 'm', spam: 's' }

function hostAndPath(url: string): string {
	try {
		const parsed = new URL(url)
		return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
	} catch {
		return url
	}
}

export function VerdictButtons(props: {
	current: Verdict | null
	onPick: (verdict: Verdict) => void
	label: string
	hints?: boolean
}) {
	return (
		<fieldset className="verdicts">
			<legend className="visually-hidden">{props.label}</legend>
			{VERDICTS.map((verdict) => (
				<button
					key={verdict}
					type="button"
					className={`verdict verdict-${verdict}`}
					aria-pressed={props.current === verdict}
					onClick={() => props.onPick(verdict)}
				>
					{verdict}
					{props.hints && <kbd>{VERDICT_KEYS[verdict]}</kbd>}
				</button>
			))}
		</fieldset>
	)
}

export function VerdictLine(props: { verdict: VerdictRecord | null; inherited?: boolean }) {
	const { verdict } = props
	if (!verdict) return <p className="verdict-line muted">no verdict</p>
	return (
		<p className="verdict-line">
			verdict <strong className={`tag tag-${verdict.value}`}>{verdict.value}</strong>
			{props.inherited && <span className="muted"> from the account</span>}
			{verdict.note && <span className="note-text"> “{verdict.note}”</span>}
			<span className="muted"> · {ago(verdict.at, Date.now())}</span>
		</p>
	)
}

export function LabelChips(props: {
	labels: ActiveLabel[]
	accountDid: string
	onRestore: (label: ActiveLabel) => void
}) {
	if (props.labels.length === 0) return null
	return (
		<ul className="labels">
			{props.labels.map((label) => (
				<li key={`${label.uri} ${label.val}`} className="label-chip">
					<span>
						{labelName(label.val)}
						<span className="label-scope"> · {label.uri === props.accountDid ? 'account' : 'site'}</span>
					</span>
					<button type="button" className="restore" onClick={() => props.onRestore(label)}>
						restore
					</button>
				</li>
			))}
		</ul>
	)
}

type CardProps = {
	site: SiteSummary
	focused: boolean
	pending: boolean
	error: string | null
	preview: boolean
	accountVerdict: Verdict | null
	actions: CardActions
	showAccountLink: boolean
}

export const SiteCard = memo(function SiteCard({
	site,
	focused,
	pending,
	error,
	preview,
	accountVerdict,
	actions,
	showAccountLink,
}: CardProps) {
	const [noteOpen, setNoteOpen] = useState(false)
	const [note, setNote] = useState('')
	const [moreOpen, setMoreOpen] = useState(false)
	const siteDown = site.labels.some((label) => label.uri === site.uri && label.val === '!takedown')
	const accountDown = site.labels.some((label) => label.uri === site.did && label.val === '!takedown')
	const hidden = site.labels.some((label) => label.uri === site.did && label.val === '!hide')
	const ownVerdict = site.verdict?.scope === 'site' ? site.verdict.value : null
	const triage = site.triage

	// A note is for the next action only.
	const takeNote = () => {
		const text = note.trim()
		setNote('')
		setNoteOpen(false)
		return text
	}

	return (
		<article
			className={`card${focused ? ' is-focused' : ''}${pending ? ' is-pending' : ''}${siteDown || accountDown ? ' is-down' : ''}`}
			data-uri={site.uri}
			tabIndex={-1}
			onFocus={() => actions.focus(site.uri)}
			aria-busy={pending}
		>
			<header className="card-head">
				<h2 className="card-title">{site.title || site.rkey}</h2>
				{pending && <span className="pending" role="status" aria-label="saving" />}
			</header>
			<a className="card-url" href={site.url} target="_blank" rel="noopener noreferrer">
				{hostAndPath(site.url)}
			</a>
			<p className="meta">
				{showAccountLink ? (
					<a href={formatRoute({ kind: 'account', did: site.did })}>@{site.handle}</a>
				) : (
					<span>@{site.handle}</span>
				)}
				<span>
					{site.files} file{site.files === 1 ? '' : 's'}
				</span>
				<span title={site.updated}>published {ago(site.updated, Date.now())}</span>
				{site.deleted && <span className="tag tag-deleted">deleted</span>}
			</p>
			{(site.domains.length > 1 || site.outbound.length > 0) && (
				<ul className="chips">
					{site.domains.slice(1).map((domain) => (
						<li key={domain} className="chip">
							{domain}
						</li>
					))}
					{site.outbound.map((host) => (
						<li key={host} className="chip chip-out" title="links to">
							→ {host}
						</li>
					))}
				</ul>
			)}
			<LabelChips
				labels={site.labels}
				accountDid={site.did}
				onRestore={(label) => actions.label(label.uri, label.val as '!takedown' | '!hide', true, '')}
			/>
			{triage && (
				<p className={`triage${triage.flag ? ' triage-flag' : ''}`}>
					<strong>{triage.category}</strong> {triage.reason}
					<span className="muted"> · {Math.round(triage.confidence * 100)}%</span>
				</p>
			)}
			{site.excerpt && <p className="excerpt">{site.excerpt}</p>}
			<VerdictLine verdict={site.verdict} inherited={site.verdict?.scope === 'account'} />
			{error && (
				<p className="card-error" role="alert">
					{error}
				</p>
			)}
			<VerdictButtons
				label="verdict on this site"
				current={ownVerdict}
				hints={focused}
				onPick={(verdict) => actions.verdict(site.uri, verdict, takeNote())}
			/>
			<div className="card-foot">
				<button type="button" className="ghost" aria-expanded={noteOpen} onClick={() => setNoteOpen((open) => !open)}>
					note
				</button>
				<button type="button" className="ghost" aria-pressed={preview} onClick={() => actions.togglePreview(site.uri)}>
					{preview ? 'close preview' : 'preview'}
				</button>
				{showAccountLink && (
					<a className="button ghost" href={formatRoute({ kind: 'account', did: site.did })}>
						account
					</a>
				)}
				<button
					type="button"
					className="ghost more-toggle"
					aria-expanded={moreOpen}
					onClick={() => setMoreOpen((open) => !open)}
				>
					takedowns {moreOpen ? '▴' : '▾'}
				</button>
			</div>
			{noteOpen && (
				<input
					className="note"
					value={note}
					onChange={(event) => setNote(event.target.value)}
					placeholder="note for the next verdict or label"
					aria-label="note"
				/>
			)}
			{moreOpen && (
				<div className="more">
					<p className="more-label">verdict on the whole account @{site.handle}</p>
					<VerdictButtons
						label="verdict on the whole account"
						current={accountVerdict}
						onPick={(verdict) => actions.verdict(site.did, verdict, takeNote())}
					/>
					<div className="danger-row">
						{siteDown ? (
							<button type="button" onClick={() => actions.label(site.uri, '!takedown', true, takeNote())}>
								restore site
							</button>
						) : (
							<button
								type="button"
								className="danger"
								onClick={() => actions.takedown(site.uri, site.title || site.rkey)}
							>
								take down site
							</button>
						)}
						{accountDown ? (
							<button type="button" onClick={() => actions.label(site.did, '!takedown', true, takeNote())}>
								restore account
							</button>
						) : (
							<button type="button" className="danger" onClick={() => actions.takedown(site.did, `@${site.handle}`)}>
								take down account
							</button>
						)}
						<button type="button" onClick={() => actions.label(site.did, '!hide', hidden, takeNote())}>
							{hidden ? 'show account on wall' : 'hide account from wall'}
						</button>
					</div>
				</div>
			)}
			{preview && (
				<iframe
					className="preview"
					src={site.url}
					title={`preview of ${site.url}`}
					sandbox=""
					referrerPolicy="no-referrer"
					loading="lazy"
				/>
			)}
		</article>
	)
})

function subjectLink(event: ModerationEvent) {
	const did = isDid(event.subject) ? event.subject : parseSiteUri(event.subject)?.did
	const text = eventSubject(event)
	if (!did) return <span>{text}</span>
	return <a href={formatRoute({ kind: 'account', did })}>{text}</a>
}

export function EventRow(props: { event: ModerationEvent; me: { did: string; handle: string } | null }) {
	const { event } = props
	return (
		<li className={`event event-${event.kind}`}>
			<span className="event-when" title={event.at}>
				{ago(event.at, Date.now())}
			</span>
			<span className="event-what">
				{subjectLink(event)} <span>{describeEvent(event)}</span>
			</span>
			<span className="event-who muted">{actorName(event.actor, props.me)}</span>
		</li>
	)
}
