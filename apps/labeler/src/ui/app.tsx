import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { Me, ModerationAction, QueueView, Verdict, VerdictRecord } from '../moderation/types'
import { ApiFailure, createApi } from './api'
import { type CardActions, EventRow, LabelChips, SiteCard, VerdictButtons, VerdictLine } from './cards'
import { isDid, labelName, shortDid } from './format'
import { commandForKey, SHORTCUTS } from './keys'
import { formatRoute, parseRoute, type Route } from './route'
import {
	type Base,
	EMPTY_LIST,
	initialState,
	inView,
	isPending,
	nextFocus,
	ownVerdict,
	project,
	reducer,
} from './state'

const PAGE = 20
const UNDO_MS = 5000
const ERROR_MS = 8000
const SEARCH_DEBOUNCE_MS = 250
const VIEWS: QueueView[] = ['flagged', 'pending', 'recent', 'reviewed']

type Toast = { id: number; text: string; error?: boolean; undo?: () => void }
type Takedown = { subject: string; what: string }

function message(error: unknown): string {
	return error instanceof ApiFailure || error instanceof Error ? error.message : String(error)
}

function useHashRoute(): Route {
	const [route, setRoute] = useState(() => parseRoute(location.hash))
	useEffect(() => {
		const update = () => setRoute(parseRoute(location.hash))
		window.addEventListener('hashchange', update)
		return () => window.removeEventListener('hashchange', update)
	}, [])
	return route
}

function listKey(route: Route): string | null {
	if (route.kind === 'queue') return route.view
	if (route.kind === 'search') return route.q.trim() ? `search:${route.q.trim()}` : null
	return null
}

function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function cardElement(uri: string): HTMLElement | null {
	return document.querySelector(`[data-uri="${CSS.escape(uri)}"]`)
}

/** Load more once the sentinel comes within a screen of the viewport. */
function LoadMore(props: { onLoad: () => void; loading: boolean; error: string | null }) {
	const ref = useRef<HTMLDivElement>(null)
	const onLoad = useRef(props.onLoad)
	onLoad.current = props.onLoad
	useEffect(() => {
		const element = ref.current
		if (!element) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) onLoad.current()
			},
			{ rootMargin: '600px 0px' },
		)
		observer.observe(element)
		return () => observer.disconnect()
	}, [])
	return (
		<div ref={ref} className="load-more">
			{props.error ? <p className="card-error">{props.error}</p> : null}
			<button type="button" className="ghost" disabled={props.loading} onClick={props.onLoad}>
				{props.loading ? 'loading…' : props.error ? 'retry' : 'load more'}
			</button>
		</div>
	)
}

function TakedownDialog(props: { request: Takedown; onConfirm: (note: string) => void; onCancel: () => void }) {
	const ref = useRef<HTMLDialogElement>(null)
	const [note, setNote] = useState('')
	useEffect(() => {
		ref.current?.showModal()
	}, [])
	const account = isDid(props.request.subject)
	return (
		<dialog ref={ref} className="dialog" onClose={props.onCancel}>
			<form
				method="dialog"
				onSubmit={(event) => {
					event.preventDefault()
					props.onConfirm(note.trim())
				}}
			>
				<h2>Take down {account ? 'account' : 'site'}?</h2>
				<p>
					<strong>{props.request.what}</strong>{' '}
					{account
						? 'and every site of the account stop being served within about 10 seconds.'
						: 'stops being served within about 10 seconds.'}{' '}
					It can be restored later.
				</p>
				<label className="field">
					<span>reason</span>
					<textarea required value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
				</label>
				<div className="dialog-actions">
					<button type="button" onClick={() => ref.current?.close()}>
						cancel
					</button>
					<button type="submit" className="danger solid" disabled={note.trim() === ''}>
						take down
					</button>
				</div>
			</form>
		</dialog>
	)
}

function App() {
	const [state, dispatch] = useReducer(reducer, undefined, initialState)
	const view = useMemo(() => project(state.base, state.ops), [state.base, state.ops])
	const route = useHashRoute()
	const [me, setMe] = useState<Me | null>(null)
	const [focused, setFocused] = useState<string | null>(null)
	const [previews, setPreviews] = useState<ReadonlySet<string>>(new Set())
	const [toasts, setToasts] = useState<Toast[]>([])
	const [takedown, setTakedown] = useState<Takedown | null>(null)
	const [help, setHelp] = useState(false)
	const [query, setQuery] = useState(route.kind === 'search' ? route.q : '')
	const searchRef = useRef<HTMLInputElement>(null)

	const api = useMemo(() => createApi(fetch.bind(globalThis), () => location.assign('/login')), [])

	// Callbacks below read the latest values through refs so they can stay stable and
	// cards (memoised) re-render only when their own site changes.
	const latest = useRef({ state, view, me })
	latest.current = { state, view, me }

	const toastId = useRef(0)
	const pushToast = useCallback((toast: Omit<Toast, 'id'>) => {
		const id = ++toastId.current
		setToasts((current) => [...current.slice(-2), { ...toast, id }])
		setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), toast.error ? ERROR_MS : UNDO_MS)
		return id
	}, [])
	const dropToast = useCallback((id: number) => setToasts((current) => current.filter((item) => item.id !== id)), [])

	// Writes on one subject go out in order, so an undo never overtakes its action.
	const chains = useRef(new Map<string, Promise<unknown>>())
	const opId = useRef(0)
	const enqueue = useCallback(<T,>(subject: string, task: () => Promise<T>): Promise<T> => {
		const run = (chains.current.get(subject) ?? Promise.resolve()).catch(() => {}).then(task)
		chains.current.set(subject, run)
		const forget = () => {
			if (chains.current.get(subject) === run) chains.current.delete(subject)
		}
		run.then(forget, forget)
		return run
	}, [])

	const describe = useCallback((base: Base, subject: string) => {
		if (isDid(subject)) {
			const handle = base.accounts[subject]?.handle ?? Object.values(base.sites).find((s) => s.did === subject)?.handle
			return handle ? `account @${handle}` : `account ${shortDid(subject)}`
		}
		const site = base.sites[subject]
		return site ? site.title || `@${site.handle}/${site.rkey}` : subject
	}, [])

	const sendVerdict = useCallback(
		(subject: string, record: VerdictRecord | null, undoText: string | null) => {
			const base = latest.current.view
			const previous = ownVerdict(base, subject)
			const id = ++opId.current
			dispatch({ type: 'op/start', op: { id, kind: 'verdict', subject, record } })
			const toast = undoText ? pushToast({ text: undoText, undo: () => sendVerdict(subject, previous, null) }) : null
			const request = { uri: subject, verdict: record?.value ?? null, ...(record?.note ? { note: record.note } : {}) }
			enqueue(subject, () => api.verdict(request)).then(
				(result) => dispatch({ type: 'op/done', id, site: result.site }),
				(error) => {
					dispatch({ type: 'op/fail', id, error: `not saved: ${message(error)}` })
					if (toast !== null) dropToast(toast)
					pushToast({
						error: true,
						text: `Verdict on ${describe(base, subject)} not saved, reverted: ${message(error)}`,
					})
				},
			)
		},
		[api, enqueue, pushToast, dropToast, describe],
	)

	const sendLabel = useCallback(
		(subject: string, val: ModerationAction, neg: boolean, note: string, undoText: string | null) => {
			const base = latest.current.view
			const id = ++opId.current
			dispatch({ type: 'op/start', op: { id, kind: 'label', subject, val, neg, cts: new Date().toISOString() } })
			const toast = undoText ? pushToast({ text: undoText, undo: () => sendLabel(subject, val, !neg, '', null) }) : null
			enqueue(subject, () => api.label({ uri: subject, val, neg, ...(note ? { note } : {}) })).then(
				(result) => dispatch({ type: 'op/done', id, labels: result.labels }),
				(error) => {
					dispatch({ type: 'op/fail', id, error: `not saved: ${message(error)}` })
					if (toast !== null) dropToast(toast)
					const change = neg ? `restoring ${val}` : val
					pushToast({
						error: true,
						text: `${change} on ${describe(base, subject)} not saved, reverted: ${message(error)}`,
					})
				},
			)
		},
		[api, enqueue, pushToast, dropToast, describe],
	)

	/** One tap: set the verdict, or clear it when it is already the subject's own. */
	const pickVerdict = useCallback(
		(subject: string, verdict: Verdict, note: string) => {
			const { view: base, me: moderator } = latest.current
			const current = ownVerdict(base, subject)
			const what = describe(base, subject)
			if (current?.value === verdict && !note) {
				sendVerdict(subject, null, `verdict cleared: ${what}`)
				return
			}
			const record: VerdictRecord = {
				value: verdict,
				note,
				by: moderator?.did ?? '',
				at: new Date().toISOString(),
				scope: isDid(subject) ? 'account' : 'site',
			}
			sendVerdict(subject, record, `${verdict}: ${what}`)
		},
		[sendVerdict, describe],
	)

	const actions: CardActions = useMemo(
		() => ({
			focus: (uri) => setFocused(uri),
			verdict: pickVerdict,
			label: (subject, val, neg, note) => {
				const what = describe(latest.current.view, subject)
				const text = neg ? `restored: ${what}` : `${labelName(val)}: ${what}`
				sendLabel(subject, val, neg, note, text)
			},
			takedown: (subject, what) => setTakedown({ subject, what }),
			togglePreview: (uri) =>
				setPreviews((current) => {
					const next = new Set(current)
					if (!next.delete(uri)) next.add(uri)
					return next
				}),
		}),
		[pickVerdict, sendLabel, describe],
	)

	// Loading.
	const loadList = useCallback(
		async (key: string, append: boolean) => {
			const list = latest.current.state.lists[key] ?? EMPTY_LIST
			if (list.loading || (append && !list.cursor)) return
			dispatch({ type: 'list/loading', key })
			try {
				if (key.startsWith('search:')) {
					const result = await api.search(key.slice('search:'.length))
					dispatch({ type: 'list/loaded', key, items: result.items, cursor: null, append: false })
				} else {
					const result = await api.queue(key as QueueView, append ? list.cursor : null, PAGE)
					dispatch({ type: 'list/loaded', key, ...result, append })
				}
			} catch (error) {
				dispatch({ type: 'list/error', key, error: message(error) })
			}
		},
		[api],
	)

	const loadEvents = useCallback(
		async (append: boolean) => {
			const events = latest.current.state.events
			if (events.loading || (append && !events.cursor)) return
			dispatch({ type: 'events/loading' })
			try {
				const result = await api.events(append ? events.cursor : null)
				dispatch({ type: 'events/loaded', ...result, append })
			} catch (error) {
				dispatch({ type: 'events/error', error: message(error) })
			}
		},
		[api],
	)

	const [accountError, setAccountError] = useState<string | null>(null)
	useEffect(() => {
		api.me().then(setMe, () => {})
		// The flagged count is wanted on every view, so it loads first whatever the route.
		if (parseRoute(location.hash).kind !== 'queue') loadList('flagged', false)
	}, [api, loadList])

	useEffect(() => {
		const key = listKey(route)
		if (key) {
			if (!latest.current.state.lists[key]?.loaded) loadList(key, false)
		} else if (route.kind === 'activity') {
			loadEvents(false)
		} else if (route.kind === 'account') {
			setAccountError(null)
			api.account(route.did).then(
				(account) => dispatch({ type: 'account/loaded', account }),
				(error) => setAccountError(message(error)),
			)
		}
		window.scrollTo(0, 0)
	}, [route, api, loadList, loadEvents])

	// Search: debounced, written to the hash so it survives a reload.
	useEffect(() => {
		const q = query.trim()
		const current = parseRoute(location.hash)
		if (current.kind === 'search' ? current.q === q : q === '') return
		const timer = setTimeout(() => {
			history.replaceState(null, '', formatRoute({ kind: 'search', q }))
			window.dispatchEvent(new HashChangeEvent('hashchange'))
		}, SEARCH_DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [query])

	// The cards on screen, in order.
	const key = listKey(route)
	const list = key ? (state.lists[key] ?? EMPTY_LIST) : null
	const account = route.kind === 'account' ? view.accounts[route.did] : undefined
	const visible = useMemo(() => {
		if (route.kind === 'queue' && list) {
			return list.uris.filter((uri) => {
				const site = view.sites[uri]
				return site !== undefined && inView(route.view, site)
			})
		}
		if (list) return list.uris
		if (account) return account.sites
		return []
	}, [route, list, account, view.sites])

	// When the focused card leaves the view (a verdict in Flagged), focus the next one
	// in its place. Nothing scrolls: the next card moves up into the same spot.
	const previousVisible = useRef<string[]>([])
	useLayoutEffect(() => {
		const before = previousVisible.current
		previousVisible.current = visible
		if (focused === null || visible.includes(focused) || !before.includes(focused)) return
		const next = nextFocus(before, visible, focused)
		setFocused(next)
		const active = document.activeElement
		if (next && (active === document.body || active === null || !active.isConnected)) {
			cardElement(next)?.focus({ preventScroll: true })
		}
	}, [visible, focused])

	const moveFocus = useCallback((uri: string | null) => {
		if (!uri) return
		setFocused(uri)
		const element = cardElement(uri)
		element?.focus({ preventScroll: true })
		element?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
	}, [])

	const undoLast = useCallback(() => {
		const toast = [...toasts].reverse().find((item) => item.undo)
		if (!toast) return
		dropToast(toast.id)
		toast.undo?.()
	}, [toasts, dropToast])

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (takedown) return
			const command = commandForKey(event, isTyping(event.target))
			if (!command) return
			const site = focused ? view.sites[focused] : undefined
			switch (command.kind) {
				case 'move': {
					const index = focused ? visible.indexOf(focused) : -1
					const target = index === -1 ? visible[0] : visible[index + command.by]
					moveFocus(target ?? null)
					break
				}
				case 'open':
					if (site) window.open(site.url, '_blank', 'noopener,noreferrer')
					break
				case 'preview':
					if (site) actions.togglePreview(site.uri)
					break
				case 'verdict':
					if (site) pickVerdict(site.uri, command.verdict, '')
					break
				case 'account':
					if (site) location.hash = formatRoute({ kind: 'account', did: site.did })
					break
				case 'search':
					searchRef.current?.focus()
					break
				case 'undo':
					undoLast()
					break
				case 'help':
					setHelp((open) => !open)
					break
				case 'escape':
					setHelp(false)
					if (isTyping(event.target)) (event.target as HTMLElement).blur()
					return
			}
			event.preventDefault()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [takedown, focused, view.sites, visible, moveFocus, actions, pickVerdict, undoLast])

	// Account verdicts by DID, once per change rather than once per card.
	const accountVerdicts = useMemo(() => {
		const byDid = new Map<string, Verdict>()
		for (const site of Object.values(view.sites)) {
			if (site.verdict?.scope === 'account') byDid.set(site.did, site.verdict.value)
		}
		for (const account of Object.values(view.accounts)) {
			if (account.verdict) byDid.set(account.did, account.verdict.value)
			else byDid.delete(account.did)
		}
		return byDid
	}, [view])

	const counts = view.counts
	const cards = (uris: string[], showAccountLink: boolean) =>
		uris.map((uri) => {
			const site = view.sites[uri]
			if (!site) return null
			return (
				<SiteCard
					key={uri}
					site={site}
					focused={focused === uri}
					pending={isPending(state.ops, site)}
					error={state.errors[uri] ?? state.errors[site.did] ?? null}
					preview={previews.has(uri)}
					accountVerdict={accountVerdicts.get(site.did) ?? null}
					actions={actions}
					showAccountLink={showAccountLink}
				/>
			)
		})

	return (
		<>
			<header className="top">
				<div className="top-row">
					<a className="brand" href="#/flagged">
						wisp moderation
					</a>
					<span className="who">
						{me ? `@${me.handle}` : ''}
						<a href="/logout">sign out</a>
					</span>
				</div>
				<input
					ref={searchRef}
					className="search"
					type="text"
					inputMode="search"
					enterKeyHint="search"
					autoComplete="off"
					spellCheck={false}
					placeholder="search handle, domain, DID or title"
					aria-label="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
			</header>
			<nav className="tabs" aria-label="views">
				{VIEWS.map((name) => (
					<a
						key={name}
						href={`#/${name}`}
						aria-current={route.kind === 'queue' && route.view === name ? 'page' : undefined}
					>
						{name}
						{counts && <span className="count">{counts[name]}</span>}
					</a>
				))}
				<a href="#/activity" aria-current={route.kind === 'activity' ? 'page' : undefined}>
					activity
				</a>
			</nav>

			<main>
				{route.kind === 'search' && !route.q.trim() && <p className="empty">Type to search.</p>}
				{list && (
					<>
						{list.loaded && visible.length === 0 && !list.cursor && (
							<p className="empty">
								{route.kind === 'queue' && route.view === 'flagged' ? 'Nothing flagged. ✓' : 'Nothing here.'}
							</p>
						)}
						{!list.loaded && list.loading && <p className="empty">loading…</p>}
						{cards(visible, true)}
						{(list.cursor || list.error) && (
							<LoadMore loading={list.loading} error={list.error} onLoad={() => key && loadList(key, true)} />
						)}
					</>
				)}
				{route.kind === 'account' && (
					<AccountPage
						did={route.did}
						account={account}
						error={accountError}
						pending={state.ops.some((op) => op.subject === route.did)}
						actionError={state.errors[route.did] ?? null}
						me={me}
						actions={actions}
					>
						{account && cards(account.sites, false)}
					</AccountPage>
				)}
				{route.kind === 'activity' && (
					<section>
						<ul className="events">
							{state.events.items.map((event) => (
								<EventRow key={event.id} event={event} me={me} />
							))}
						</ul>
						{(state.events.cursor || state.events.error) && (
							<LoadMore loading={state.events.loading} error={state.events.error} onLoad={() => loadEvents(true)} />
						)}
					</section>
				)}
			</main>

			<footer className="shortcuts-hint">
				<button type="button" className="ghost small" onClick={() => setHelp((open) => !open)}>
					keyboard shortcuts <kbd>?</kbd>
				</button>
			</footer>
			{help && (
				<aside className="help" aria-label="keyboard shortcuts">
					<dl>
						{SHORTCUTS.map(([keys, what]) => (
							<div key={keys}>
								<dt>
									<kbd>{keys}</kbd>
								</dt>
								<dd>{what}</dd>
							</div>
						))}
					</dl>
				</aside>
			)}

			<ol className="toasts" aria-live="polite">
				{toasts.map((toast) => (
					<li key={toast.id} className={`toast${toast.error ? ' toast-error' : ''}`}>
						<span>{toast.text}</span>
						{toast.undo && (
							<button
								type="button"
								onClick={() => {
									dropToast(toast.id)
									toast.undo?.()
								}}
							>
								undo
							</button>
						)}
						<button type="button" className="ghost" aria-label="dismiss" onClick={() => dropToast(toast.id)}>
							×
						</button>
					</li>
				))}
			</ol>

			{takedown && (
				<TakedownDialog
					request={takedown}
					onCancel={() => setTakedown(null)}
					onConfirm={(note) => {
						const { subject, what } = takedown
						setTakedown(null)
						sendLabel(subject, '!takedown', false, note, `taken down: ${what}`)
					}}
				/>
			)}
		</>
	)
}

function AccountPage(props: {
	did: string
	account: Base['accounts'][string] | undefined
	error: string | null
	pending: boolean
	actionError: string | null
	me: Me | null
	actions: CardActions
	children: React.ReactNode
}) {
	const { account, actions } = props
	if (!account) {
		return <p className="empty">{props.error ? `Could not load the account: ${props.error}` : 'loading…'}</p>
	}
	const down = account.labels.some((label) => label.val === '!takedown')
	const hidden = account.labels.some((label) => label.val === '!hide')
	return (
		<section className="account" aria-busy={props.pending}>
			<header className={`account-head card${down ? ' is-down' : ''}`}>
				<div className="card-head">
					<h1 className="card-title">@{account.handle}</h1>
					{props.pending && <span className="pending" role="status" aria-label="saving" />}
				</div>
				<p className="meta">
					<code>{account.did}</code>
					<span>
						{account.sites.length} site{account.sites.length === 1 ? '' : 's'}
					</span>
				</p>
				<LabelChips
					labels={account.labels}
					accountDid={account.did}
					onRestore={(label) => actions.label(label.uri, label.val as ModerationAction, true, '')}
				/>
				<VerdictLine verdict={account.verdict} />
				{props.actionError && (
					<p className="card-error" role="alert">
						{props.actionError}
					</p>
				)}
				<VerdictButtons
					label="verdict on the whole account"
					current={account.verdict?.value ?? null}
					onPick={(verdict) => actions.verdict(account.did, verdict, '')}
				/>
				<div className="danger-row">
					{down ? (
						<button type="button" onClick={() => actions.label(account.did, '!takedown', true, '')}>
							restore account
						</button>
					) : (
						<button
							type="button"
							className="danger"
							onClick={() => actions.takedown(account.did, `@${account.handle}`)}
						>
							take down account
						</button>
					)}
					<button type="button" onClick={() => actions.label(account.did, '!hide', hidden, '')}>
						{hidden ? 'show account on wall' : 'hide account from wall'}
					</button>
				</div>
			</header>
			<h2 className="section-title">Sites</h2>
			{props.children}
			<h2 className="section-title">Recent events</h2>
			{account.events.length === 0 ? (
				<p className="empty">No events.</p>
			) : (
				<ul className="events">
					{account.events.map((event) => (
						<EventRow key={event.id} event={event} me={props.me} />
					))}
				</ul>
			)}
		</section>
	)
}

const root = document.getElementById('root')
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	)
}
