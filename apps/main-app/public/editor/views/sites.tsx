import { useId, useState } from 'react'
import { api, errorText, type UserInfo } from '../api'
import { confirmAction } from '../confirm'
import { expiresIn, formatBytes, plural, timeAgo } from '../format'
import { type RowProps, rowActions, useRovingList } from '../keys'
import { defaultSiteAddress, isPreviewSite, type PrivateSite, type PublicSite, type Site, siteAddress } from '../model'
import { keys, useAction, usePdsSync, useSites } from '../queries'
import { notify } from '../store'
import { Button, Empty, ExternalLink, Notice, openInNewTab, Section, SkeletonRows, Tag } from '../ui'
import { PrivateShares } from './private-shares'
import { SiteSettingsDialog } from './site-settings'

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

export function SitesView({ user, onDeploy }: SitesViewProps) {
	const sites = useSites()
	const sync = usePdsSync()
	const [expanded, setExpanded] = useState<string | null>(null)
	const [configuring, setConfiguring] = useState<PublicSite | null>(null)
	const [showPreviews, setShowPreviews] = useState(false)
	const handle = user?.handle ?? '…'
	const all = sites.data ?? []
	// Pull-request previews pile up one per round; they stay out of the way unless asked for.
	const previewCount = all.filter(isPreviewSite).length
	const list = showPreviews ? all : all.filter((site) => !isPreviewSite(site))

	const deleteSite = useAction(
		(site: Site) => (site.kind === 'public' ? api.deleteSite(site.rkey) : api.deletePrivateSite(site.siteId)),
		{
			invalidates: [keys.sites, keys.domains],
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
			<ul className="rows">
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
			</ul>
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
		<li>
			<button
				type="button"
				{...rowProps}
				className="row-line flex-wrap"
				aria-expanded={expanded}
				aria-controls={detailId}
				onClick={onToggle}
			>
				<span className="w-52 shrink-0 truncate text-[0.95rem] font-bold text-ink">{site.name}</span>
				<span className="min-w-0 flex-1 truncate text-[0.8rem] text-ink-soft max-sm:basis-full">
					{isPublic ? siteAddress(site, handle) : expiresIn(site.expiresAt)}
				</span>
				{isPublic && site.domains.length > 1 && <Tag>+{site.domains.length - 1}</Tag>}
				{!isPublic && <Tag tone="lilac">private</Tag>}
				{!isPublic && site.expired && <Tag tone="butter">expired</Tag>}
				<span className="w-20 shrink-0 text-right text-xs text-ink-soft max-sm:hidden">
					{timeAgo(isPublic ? site.updatedAt : site.createdAt)}
				</span>
			</button>
			{expanded && (
				<div id={detailId} className="row-detail">
					{isPublic ? (
						<PublicSiteDetail site={site} handle={handle} />
					) : (
						<PrivateSiteDetail site={site} onOpen={onOpen} />
					)}
					<div className="mt-3 flex flex-wrap gap-2">
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
				</div>
			)}
		</li>
	)
}

function PublicSiteDetail({ site, handle }: { site: PublicSite; handle: string }) {
	const fallback = defaultSiteAddress(handle, site.rkey)
	return (
		<dl className="kv">
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
			<dt>default</dt>
			<dd>
				<ExternalLink href={`https://${fallback}`}>{fallback}</ExternalLink>
			</dd>
			<dt>updated</dt>
			<dd>
				{timeAgo(site.updatedAt)} <span className="text-ink-soft">· created {timeAgo(site.createdAt)}</span>
			</dd>
		</dl>
	)
}

function PrivateSiteDetail({ site, onOpen }: { site: PrivateSite; onOpen: () => void }) {
	return (
		<>
			<dl className="kv">
				<dt>url</dt>
				<dd>
					<button type="button" onClick={onOpen} className="break-all text-left text-rose hover:underline">
						{site.url} <span aria-hidden="true">↗</span>
					</button>
				</dd>
				<dt>contents</dt>
				<dd>
					{plural(site.fileCount, 'file')} · {formatBytes(site.totalBytes)}
				</dd>
				<dt>expiry</dt>
				<dd>{expiresIn(site.expiresAt)}</dd>
			</dl>
			<PrivateShares siteId={site.siteId} />
		</>
	)
}
