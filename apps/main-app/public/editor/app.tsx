import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react'
import { ApiError, api, type UserInfo } from './api'
import { ConfirmHost } from './confirm'
import { isTypingTarget } from './keys'
import { useAction, useUser } from './queries'
import { noticeStore, useStore } from './store'
import { useTheme } from './theme'
import { Button, cx, ExternalLink, Kbd, Notice, Tag } from './ui'
import { CliView } from './views/cli'
import { DomainsView } from './views/domains'
import { SitesView } from './views/sites'
import { UploadView } from './views/upload'
import { WebhooksView } from './views/webhooks'

type Hint = readonly [keys: string, action: string]

const MOVE: Hint = ['j k', 'move']

const TABS = [
	{ id: 'sites', hints: [MOVE, ['⏎', 'expand'], ['o', 'open'], ['c', 'configure'], ['d', 'delete']] },
	{ id: 'domains', hints: [MOVE, ['⏎', 'visit · dns'], ['o', 'open'], ['v', 'verify'], ['d', 'remove']] },
	{ id: 'upload', hints: [['tab', 'next field']] },
	{ id: 'webhooks', hints: [MOVE, ['⏎', 'expand'], ['n', 'new'], ['r', 'rotate'], ['d', 'delete']] },
	{ id: 'cli', label: 'cli & ci', hints: [MOVE, ['⏎', 'set up'], ['tab', 'next field']] },
] as const satisfies readonly { id: string; label?: string; hints: readonly Hint[] }[]

type TabId = (typeof TABS)[number]['id']

/** Number keys jump straight to a tab; ← and → step through them, wrapping at either end. */
const tabForKey = (key: string, current: number): number | null => {
	if (/^[1-9]$/.test(key)) return Number(key) - 1
	if (key === 'ArrowLeft') return (current - 1 + TABS.length) % TABS.length
	if (key === 'ArrowRight') return (current + 1) % TABS.length
	return null
}

/**
 * Each list keeps its cursor row in the tab order, so focusing that row puts the cursor back where it was.
 * The pane only scrolls if the row is out of view, so a restored scroll position survives.
 */
const focusCurrentRow = (panel: HTMLElement | null | undefined) => {
	const row = panel?.querySelector<HTMLElement>('[data-row][tabindex="0"]')
	row?.focus({ preventScroll: true })
	row?.scrollIntoView({ block: 'nearest' })
}

const tabFromHash = (): TabId => TABS.find((tab) => `#${tab.id}` === window.location.hash)?.id ?? 'sites'

const panelFor = (tab: TabId, user: UserInfo | undefined, select: (tab: TabId) => void): ReactNode => {
	switch (tab) {
		case 'sites':
			return <SitesView user={user} onDeploy={() => select('upload')} />
		case 'domains':
			return <DomainsView user={user} />
		case 'upload':
			return <UploadView user={user} />
		case 'webhooks':
			return <WebhooksView user={user} />
		case 'cli':
			return <CliView user={user} />
	}
}

export function App() {
	const user = useUser()
	const [tab, setTab] = useState<TabId>(tabFromHash)
	const panels = useRef<Partial<Record<TabId, HTMLElement | null>>>({})
	// The api answers a missing session with a 4xx (400 today, not 401); 5xx and network errors stay on the page.
	const signedOut = user.error instanceof ApiError && user.error.status >= 400 && user.error.status < 500

	useEffect(() => {
		if (signedOut) window.location.replace('/')
	}, [signedOut])

	const body = useRef<HTMLElement>(null)
	// The panels share one scrolling body, so each tab's position is saved on the way out and restored on the way back.
	const scrollFor = useRef<Partial<Record<TabId, number>>>({})

	const select = (next: TabId) => {
		scrollFor.current[tab] = body.current?.scrollTop ?? 0
		setTab(next)
		window.history.replaceState(null, '', `#${next}`)
	}

	// Set when a key switches tabs from inside a list: the new panel's cursor takes focus once it is visible.
	const returnToRow = useRef(false)

	useEffect(() => {
		body.current?.scrollTo({ top: scrollFor.current[tab] ?? 0 })
		if (!returnToRow.current) return
		returnToRow.current = false
		focusCurrentRow(panels.current[tab])
	}, [tab])

	const onGlobalKey = useEffectEvent((event: KeyboardEvent) => {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
		if (isTypingTarget(event.target) || document.querySelector('dialog[open]')) return

		const target = tabForKey(
			event.key,
			TABS.findIndex((entry) => entry.id === tab),
		)
		const next = target === null ? undefined : TABS[target]
		if (next) {
			event.preventDefault()
			const onTab = event.target instanceof HTMLElement && event.target.role === 'tab'
			returnToRow.current = !onTab
			select(next.id)
			if (onTab) document.getElementById(`tab-${next.id}`)?.focus()
			return
		}

		// Section actions like "+ new" carry data-hotkey and answer from anywhere in their panel.
		const hotkey = panels.current[tab]?.querySelector<HTMLElement>(`[data-hotkey="${CSS.escape(event.key)}"]`)
		if (hotkey) {
			event.preventDefault()
			hotkey.click()
			return
		}

		// Nothing in the panel focused yet (page or tab strip): j/k drop back onto the list's cursor.
		const outsidePanel =
			document.activeElement === document.body || (event.target instanceof HTMLElement && event.target.role === 'tab')
		if (outsidePanel && ['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
			event.preventDefault()
			focusCurrentRow(panels.current[tab])
		}
	})

	useEffect(() => {
		const listener = (event: KeyboardEvent) => onGlobalKey(event)
		window.addEventListener('keydown', listener)
		return () => window.removeEventListener('keydown', listener)
	}, [])

	const hints = TABS.find((entry) => entry.id === tab)?.hints ?? []

	return (
		// The page itself never scrolls: header, key hints, tabs and footer stay put and only the pane's body scrolls.
		<div className="flex h-dvh flex-col overflow-hidden">
			<Header user={user.data} />
			<div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-6 pt-4 pb-5">
				<KeyHints hints={hints} />
				{/* One terminal pane: the tabs are its title strip, the rows live inside. The fairy holds its left edge. */}
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border-2 border-rail bg-pane">
					<div
						role="tablist"
						aria-label="dashboard"
						className="grid grid-cols-3 gap-1.5 border-b-2 border-rail bg-paper-2 px-4 py-2 sm:grid-cols-5"
					>
						{TABS.map((entry, index) => (
							<button
								key={entry.id}
								type="button"
								role="tab"
								id={`tab-${entry.id}`}
								aria-selected={tab === entry.id}
								aria-controls={`panel-${entry.id}`}
								tabIndex={tab === entry.id ? 0 : -1}
								onClick={() => select(entry.id)}
								className={cx(
									'rounded-full border-2 px-3.5 py-0.5 text-center transition-colors',
									tab === entry.id
										? 'border-line bg-pink font-bold text-on-pastel shadow-[2px_2px_0_var(--shadow)]'
										: 'border-transparent text-ink-soft hover:text-ink',
								)}
							>
								<span className="mr-1.5 opacity-70">{index + 1}</span>
								{'label' in entry ? entry.label : entry.id}
							</button>
						))}
					</div>
					<main ref={body} className="pane-body min-h-0 flex-1 overflow-y-auto px-6 py-6">
						{user.isError && !signedOut && <Notice tone="bad">could not reach wisp.place, try reloading</Notice>}
						{TABS.map((entry) => (
							<section
								key={entry.id}
								ref={(element) => {
									panels.current[entry.id] = element
								}}
								role="tabpanel"
								id={`panel-${entry.id}`}
								aria-labelledby={`tab-${entry.id}`}
								hidden={tab !== entry.id}
							>
								{panelFor(entry.id, user.data, select)}
							</section>
						))}
					</main>
				</div>
			</div>
			<Footer />
			<ConfirmHost />
		</div>
	)
}

function Header({ user }: { user: UserInfo | undefined }) {
	const { isDark, toggle } = useTheme()
	const logout = useAction(api.logout, { failure: 'could not sign out' })

	return (
		<header className="border-b-2 border-dashed border-rule">
			<div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
				<a
					href="/home"
					className="group flex items-center gap-2 font-display text-xl font-bold text-ink hover:no-underline"
				>
					<img
						src="/fairy.webp"
						alt=""
						width={21}
						height={32}
						className="transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:-rotate-12"
					/>
					wisp.place
				</a>
				<span className="text-ink-soft">/ dashboard</span>
				<div className="ml-auto flex items-center gap-3">
					{user ? (
						<ExternalLink href={`https://bsky.app/profile/${user.did}`} className="text-ink-soft">
							@{user.handle}
						</ExternalLink>
					) : (
						<span className="skeleton h-4 w-28" />
					)}
					{user?.isSupporter && <Tag tone="butter">supporter ♡</Tag>}
					<button
						type="button"
						onClick={toggle}
						aria-label={`switch to the ${isDark ? 'light' : 'dark'} theme`}
						className="grid size-8 place-items-center rounded-full border-2 border-line bg-card text-ink shadow-[2px_2px_0_var(--shadow)] transition-transform hover:rotate-12"
					>
						{isDark ? '☀' : '☾'}
					</button>
					<Button
						variant="ghost"
						busy={logout.isPending}
						onClick={() => logout.mutate(undefined, { onSuccess: () => window.location.assign('/') })}
					>
						sign out
					</Button>
				</div>
			</div>
		</header>
	)
}

const FOOTER_LINKS = [
	{ label: 'docs', href: 'https://docs.wisp.place' },
	{ label: 'status', href: 'https://status.wisp.place' },
	{ label: 'acceptable use', href: '/acceptable-use' },
	{ label: 'privacy', href: '/privacy' },
	{ label: 'contact@wisp.place', href: 'mailto:contact@wisp.place' },
	{ label: 'legal@wisp.place', href: 'mailto:legal@wisp.place' },
] as const

/** The fairy sits on the footer's rail in the left gutter, one hand over the pane's edge. */
const Mascot = () => (
	<span className="mascot" aria-hidden="true">
		<img src="/corner.png" alt="" decoding="async" />
	</span>
)

/** The bottom bar: its top edge is the rail the fairy sits on. */
const Footer = () => (
	<footer className="border-t-2 border-rail bg-paper-2">
		<div className="relative mx-auto flex max-w-6xl flex-wrap gap-x-5 gap-y-1 px-6 py-3 text-xs text-ink-soft">
			<Mascot />
			<span>built with ♡ by @nekomimi.pet</span>
			{FOOTER_LINKS.map((link) => (
				<a key={link.href} href={link.href} className="text-ink-soft hover:text-rose">
					{link.label}
				</a>
			))}
		</div>
	</footer>
)

/** Shortcuts for the visible tab above the pane, with the latest status on the right. */
function KeyHints({ hints }: { hints: readonly Hint[] }) {
	const notice = useStore(noticeStore)
	return (
		<div className="flex min-h-7 items-center gap-4 pb-3 text-xs">
			<span className="flex flex-wrap gap-x-4 gap-y-1 text-ink-soft max-md:hidden">
				<span>
					<Kbd>1–5</Kbd> tabs
				</span>
				{hints.map(([keys, action]) => (
					<span key={action}>
						<Kbd>{keys}</Kbd> {action}
					</span>
				))}
			</span>
			<output aria-live="polite" className="ml-auto min-w-0 truncate">
				{notice && (
					<span key={notice.id} className={notice.tone === 'ok' ? 'text-ok' : 'text-bad'}>
						{notice.tone === 'ok' ? '✓' : '✗'} {notice.text}
					</span>
				)}
			</output>
		</div>
	)
}
