import { useId, useState } from 'react'
import { api, errorText, type SiteDomain, type UserInfo } from '../api'
import { confirmAction } from '../confirm'
import { expiresIn, formatBytes, plural, timeAgo } from '../format'
import { type RowProps, rowActions, useRovingList } from '../keys'
import { defaultSiteAddress, isPreviewSite, type PrivateSite, type PublicSite, type Site, siteAddress } from '../model'
import { expectSiteChange, keys, useAction, usePdsSync, useSites } from '../queries'
import { notify } from '../store'
import {
	Button,
	CHEVRON,
	type Column,
	DetailRow,
	Empty,
	ExternalLink,
	Input,
	Notice,
	openInNewTab,
	Row,
	Section,
	Sheet,
	SkeletonRows,
	Status,
	Tag,
} from '../ui'
import { PrivateShares } from './private-shares'
import { SiteSettingsDialog } from './site-settings'

const COLUMNS: readonly Column[] = [
	CHEVRON,
	{ name: 'name' },
	{ name: 'address' },
	{ name: 'status' },
	{ name: 'domains', className: 'max-sm:hidden' },
	{ name: 'updated', align: 'right', className: 'max-sm:hidden' },
]

interface SitesViewProps {
	user: UserInfo | undefined
	onDeploy: () => void
}

/** Private sites open through a short-lived owner handoff rather than a stored URL. */
async function openPrivateSite(site: PrivateSite) {
	try {
		openInNewTab((await api.openPrivateSite(site.siteId)).url)
	} catch (error) {
		notify.error(`could not open ${site.name}: ${errorText(error)}`)
	}
}

/** "1 custom · 2 wisp", or a dash when the site only answers at its default address. */
const domainSummary = (domains: readonly SiteDomain[]): string => {
	const custom = domains.filter((domain) => domain.type === 'custom').length
	const wisp = domains.length - custom
	const parts = [custom && `${custom} custom`, wisp && `${wisp} wisp`].filter(Boolean)
	return parts.length ? parts.join(' · ') : '—'
}

const matches = (site: Site, handle: string, query: string) =>
	site.name.toLowerCase().includes(query) ||
	(site.kind === 'public' && siteAddress(site, handle).toLowerCase().includes(query))

export function SitesView({ user, onDeploy }: SitesViewProps) {
	const sites = useSites()
	const sync = usePdsSync()
	const [expanded, setExpanded] = useState<string | null>(null)
	const [configuring, setConfiguring] = useState<PublicSite | null>(null)
	const [showPreviews, setShowPreviews] = useState(false)
	const [query, setQuery] = useState('')
	const handle = user?.handle ?? '…'
	const all = sites.data ?? []
	// Pull-request previews pile up one per round; they stay out of the way unless asked for.
	const previewCount = all.filter(isPreviewSite).length
	const needle = query.trim().toLowerCase()
	const list = all
		.filter((site) => showPreviews || !isPreviewSite(site))
		.filter((site) => !needle || matches(site, handle, needle))

	const deleteSite = useAction(
		async (site: Site) => {
			await (site.kind === 'public' ? api.deleteSite(site.rkey) : api.deletePrivateSite(site.siteId))
			// Not awaited: the row goes at once and the list catches up behind it.
			void expectSiteChange({ kind: 'deleted', key: site.key, name: site.name })
		},
		{
			invalidates: [keys.domains],
			success: (_, site) => `deleted ${site.name}`,
			failure: 'could not delete site',
		},
	)

	const open = (site: Site) =>
		site.kind === 'public' ? openInNewTab(`https://${siteAddress(site, handle)}`) : openPrivateSite(site)

	const configure = (site: Site) => site.kind === 'public' && setConfiguring(site)

	const remove = async (site: Site) => {
		const confirmed = await confirmAction({
			title: `delete ${site.name}?`,
			body:
				site.kind === 'public'
					? 'Its manifest is removed from your PDS and it stops being served. Mapped domains are released.'
					: 'The private copy and every share link to it stop working right away.',
			action: 'delete',
		})
		if (confirmed) deleteSite.mutate(site, { onSuccess: () => setConfiguring(null) })
	}

	const rowProps = useRovingList(list.length, rowActions(list, { o: open, c: configure, d: remove }))

	return (
		<Section
			title="sites"
			meta={sites.data && `${plural(list.length, 'site')}${sync.isPending ? ' · checking your pds…' : ''}`}
			actions={
				<>
					{previewCount > 0 && (
						<Button variant="ghost" aria-pressed={showPreviews} onClick={() => setShowPreviews((shown) => !shown)}>
							{showPreviews ? 'hide previews' : `show ${plural(previewCount, 'preview')}`}
						</Button>
					)}
					<Button variant="primary" onClick={onDeploy}>
						+ deploy
					</Button>
				</>
			}
		>
			{sites.isPending && <SkeletonRows />}
			{sites.isError && <Notice tone="bad">could not load your sites: {sites.error.message}</Notice>}
			{sites.isSuccess && all.length === 0 && (
				<Empty>
					{sync.isPending ? 'fetching your sites from your pds ✦' : 'nothing here yet, go put some stuff somewhere ✦'}
				</Empty>
			)}
			{all.length > 8 && (
				<Input
					aria-label="filter sites"
					placeholder="filter by name or address"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					className="mb-3"
				/>
			)}
			{list.length > 0 && (
				<Sheet columns={COLUMNS}>
					{list.map((site, index) => (
						<SiteRow
							key={site.key}
							site={site}
							handle={handle}
							expanded={expanded === site.key}
							onToggle={() => setExpanded((current) => (current === site.key ? null : site.key))}
							rowProps={rowProps(index)}
							onOpen={() => open(site)}
							onConfigure={() => configure(site)}
							onDelete={() => remove(site)}
							deleting={deleteSite.isPending && deleteSite.variables?.key === site.key}
						/>
					))}
				</Sheet>
			)}
			<SiteSettingsDialog site={configuring} onClose={() => setConfiguring(null)} onDelete={remove} />
		</Section>
	)
}

interface SiteRowProps {
	site: Site
	handle: string
	expanded: boolean
	onToggle: () => void
	rowProps: RowProps
	onOpen: () => void
	onConfigure: () => void
	onDelete: () => void
	deleting: boolean
}

const SiteStatus = ({ site }: { site: Site }) => {
	if (site.kind === 'public') {
		return site.deploying ? <Status tone="muted">deploying</Status> : <Status tone="ok">live</Status>
	}
	if (site.expired) return <Status tone="warn">expired</Status>
	return <Status tone="lock">private</Status>
}

function SiteRow({
	site,
	handle,
	expanded,
	onToggle,
	rowProps,
	onOpen,
	onConfigure,
	onDelete,
	deleting,
}: SiteRowProps) {
	const detailId = useId()
	const isPublic = site.kind === 'public'

	return (
		<>
			<Row rowProps={rowProps} onActivate={onToggle} expanded={expanded} controls={detailId}>
				<td className="chev" />
				<td className="name">{site.name}</td>
				<td className="max-w-0 truncate text-[0.8rem]">
					{isPublic ? siteAddress(site, handle) : <span className="italic opacity-60">private link</span>}
				</td>
				<td>
					<SiteStatus site={site} />
				</td>
				<td className="max-sm:hidden">{isPublic ? domainSummary(site.domains) : '—'}</td>
				<td className="num whitespace-nowrap text-xs max-sm:hidden">
					{isPublic ? (
						timeAgo(site.updatedAt)
					) : (
						<span className="flex flex-col leading-snug">
							{timeAgo(site.createdAt)}
							<span className="opacity-80">{expiresIn(site.expiresAt)}</span>
						</span>
					)}
				</td>
			</Row>
			{expanded && (
				<DetailRow id={detailId} span={COLUMNS.length}>
					{isPublic ? (
						<PublicSiteDetail site={site} handle={handle} />
					) : (
						<PrivateSiteDetail site={site} onOpen={onOpen} />
					)}
					<div className="mt-4 flex flex-wrap gap-2">
						<Button onClick={onOpen} shortcut="o">
							open
						</Button>
						{isPublic && (
							<Button onClick={onConfigure} shortcut="c">
								configure
							</Button>
						)}
						<Button variant="danger" onClick={onDelete} busy={deleting} shortcut="d">
							delete
						</Button>
					</div>
				</DetailRow>
			)}
		</>
	)
}

function PublicSiteDetail({ site, handle }: { site: PublicSite; handle: string }) {
	const fallback = defaultSiteAddress(handle, site.rkey)
	return (
		<dl className="detail-grid">
			<div>
				<dt>domains</dt>
				<dd className="flex flex-wrap gap-x-4 gap-y-1">
					{site.domains.length === 0 && <span className="text-ink-soft">none yet, configure to map one</span>}
					{site.domains.map((domain) => (
						<span key={domain.domain} className="inline-flex items-center gap-2">
							<ExternalLink href={`https://${domain.domain}`}>{domain.domain}</ExternalLink>
							<Tag tone={domain.type === 'custom' ? 'mint' : undefined}>{domain.type}</Tag>
						</span>
					))}
				</dd>
			</div>
			<div>
				<dt>default address</dt>
				<dd>
					<ExternalLink href={`https://${fallback}`}>{fallback}</ExternalLink>
				</dd>
			</div>
			<div>
				<dt>updated</dt>
				<dd>
					{timeAgo(site.updatedAt)} <span className="text-ink-soft">· created {timeAgo(site.createdAt)}</span>
				</dd>
			</div>
		</dl>
	)
}

function PrivateSiteDetail({ site, onOpen }: { site: PrivateSite; onOpen: () => void }) {
	return (
		<>
			<dl className="detail-grid">
				<div>
					<dt>url</dt>
					<dd>
						<button type="button" onClick={onOpen} className="break-all text-left text-rose hover:underline">
							{site.url} <span aria-hidden="true">↗</span>
						</button>
					</dd>
				</div>
				<div>
					<dt>contents</dt>
					<dd>
						{plural(site.fileCount, 'file')} · {formatBytes(site.totalBytes)}
					</dd>
				</div>
				<div>
					<dt>expiry</dt>
					<dd>{expiresIn(site.expiresAt)}</dd>
				</div>
			</dl>
			<div className="mt-4">
				<PrivateShares siteId={site.siteId} />
			</div>
		</>
	)
}
