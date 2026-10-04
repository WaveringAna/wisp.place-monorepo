import { type FormEvent, type ReactNode, useId, useState } from 'react'
import { api, type CustomDomain, errorText, type SiteSettings, type WispDomain } from '../api'
import {
	customKey,
	type DomainKey,
	domainMappingChanges,
	fromSettingsDraft,
	mappedDomainKeys,
	type PublicSite,
	type RoutingMode,
	type SettingsDraft,
	toSettingsDraft,
	wispKey,
} from '../model'
import { keys, useAction, useDomains, useSiteSettings } from '../queries'
import { Button, Dialog, Notice, SkeletonRows, Tag, TextField, Toggle } from '../ui'

interface SiteConfigChange {
	rkey: string
	map: DomainKey[]
	unmap: DomainKey[]
	settings: SiteSettings
}

const pointDomain = (key: DomainKey, rkey: string | null) =>
	key.startsWith('wisp:') ? api.mapWispDomain(key.slice(5), rkey) : api.mapCustomDomain(key.slice(7), rkey)

async function saveSiteConfig({ rkey, map, unmap, settings }: SiteConfigChange) {
	await Promise.all([...unmap.map((key) => pointDomain(key, null)), ...map.map((key) => pointDomain(key, rkey))])
	await api.saveSiteSettings(rkey, settings)
}

interface SiteSettingsDialogProps {
	site: PublicSite | null
	onClose: () => void
	onDelete: (site: PublicSite) => void
}

export function SiteSettingsDialog({ site, onClose, onDelete }: SiteSettingsDialogProps) {
	const formId = useId()
	const save = useAction(saveSiteConfig, {
		invalidates: [keys.sites, keys.domains],
		success: (_, change) => `saved ${change.rkey}`,
		failure: 'could not save settings',
	})

	return (
		<Dialog
			open={site !== null}
			onClose={onClose}
			title={`configure ${site?.name ?? ''}`}
			footer={
				site && (
					<>
						<Button variant="danger" onClick={() => onDelete(site)}>
							delete site
						</Button>
						<Button variant="ghost" className="ml-auto" onClick={onClose}>
							cancel
						</Button>
						<Button variant="primary" type="submit" form={formId} busy={save.isPending}>
							save
						</Button>
					</>
				)
			}
		>
			{site && (
				<SettingsLoader
					site={site}
					formId={formId}
					onSubmit={(change) => save.mutate(change, { onSuccess: onClose })}
				/>
			)}
		</Dialog>
	)
}

interface SettingsFormProps {
	site: PublicSite
	formId: string
	onSubmit: (change: SiteConfigChange) => void
}

function SettingsLoader(props: SettingsFormProps) {
	const settings = useSiteSettings(props.site.rkey)
	const domains = useDomains()
	if (settings.isError || domains.isError) {
		return <Notice tone="bad">could not load settings: {errorText(settings.error ?? domains.error)}</Notice>
	}
	if (!settings.data || !domains.data) return <SkeletonRows count={4} />
	return <SettingsForm {...props} settings={settings.data} wisp={domains.data.wisp} custom={domains.data.custom} />
}

const ROUTING: { mode: RoutingMode; label: string }[] = [
	{ mode: 'default', label: 'default' },
	{ mode: 'spa', label: 'spa' },
	{ mode: 'directory', label: 'directory listing' },
	{ mode: 'custom404', label: 'custom 404' },
]

const Group = ({ legend, children }: { legend: string; children: ReactNode }) => (
	<fieldset className="mb-6 space-y-2">
		<legend className="mb-2 font-bold">
			<span className="text-rose" aria-hidden="true">
				##{' '}
			</span>
			{legend}
		</legend>
		{children}
	</fieldset>
)

interface DomainChoice {
	key: DomainKey
	domain: string
	type: 'wisp' | 'custom'
	elsewhere: string | null
}

const domainChoices = (rkey: string, wisp: WispDomain[], custom: CustomDomain[]): DomainChoice[] => [
	...wisp.map((domain) => ({
		key: wispKey(domain),
		domain: domain.domain,
		type: 'wisp' as const,
		elsewhere: domain.rkey !== rkey ? domain.rkey : null,
	})),
	...custom
		.filter((domain) => domain.verified)
		.map((domain) => ({
			key: customKey(domain),
			domain: domain.domain,
			type: 'custom' as const,
			elsewhere: domain.rkey !== rkey ? domain.rkey : null,
		})),
]

function SettingsForm({
	site,
	formId,
	onSubmit,
	settings,
	wisp,
	custom,
}: SettingsFormProps & { settings: SiteSettings; wisp: WispDomain[]; custom: CustomDomain[] }) {
	const current = mappedDomainKeys(site.rkey, wisp, custom)
	const [selected, setSelected] = useState<ReadonlySet<DomainKey>>(current)
	const [draft, setDraft] = useState(() => toSettingsDraft(settings))
	const patch = (change: Partial<SettingsDraft>) => setDraft((previous) => ({ ...previous, ...change }))
	const choices = domainChoices(site.rkey, wisp, custom)

	const toggleDomain = (key: DomainKey, on: boolean) =>
		setSelected((previous) => {
			const next = new Set(previous)
			if (on) next.add(key)
			else next.delete(key)
			return next
		})

	const submit = (event: FormEvent) => {
		event.preventDefault()
		onSubmit({
			rkey: site.rkey,
			...domainMappingChanges(current, selected),
			settings: fromSettingsDraft(draft, settings),
		})
	}

	return (
		<form id={formId} onSubmit={submit}>
			<Group legend="domains">
				{choices.length === 0 && (
					<p className="text-ink-soft">no domains yet, claim a wisp.place subdomain or verify a custom one first</p>
				)}
				{choices.map((choice) => (
					<Toggle
						key={choice.key}
						className="flex"
						checked={selected.has(choice.key)}
						onChange={(event) => toggleDomain(choice.key, event.target.checked)}
						label={
							<span className="inline-flex flex-wrap items-center gap-2">
								{choice.domain}
								<Tag tone={choice.type === 'custom' ? 'mint' : undefined}>{choice.type}</Tag>
								{choice.elsewhere && <span className="text-xs text-ink-soft">now → {choice.elsewhere}</span>}
							</span>
						}
					/>
				))}
			</Group>

			<Group legend="routing">
				{ROUTING.map(({ mode, label }) => (
					<div key={mode}>
						<Toggle
							type="radio"
							name="routing"
							className="flex"
							checked={draft.routing === mode}
							onChange={() => patch({ routing: mode })}
							label={label}
						/>
						{mode === 'spa' && draft.routing === 'spa' && (
							<TextField
								label="spa file"
								className="ml-9 mt-1 max-w-xs"
								value={draft.spaFile}
								onChange={(event) => patch({ spaFile: event.target.value })}
							/>
						)}
						{mode === 'custom404' && draft.routing === 'custom404' && (
							<TextField
								label="404 file"
								className="ml-9 mt-1 max-w-xs"
								value={draft.notFoundFile}
								onChange={(event) => patch({ notFoundFile: event.target.value })}
							/>
						)}
					</div>
				))}
			</Group>

			<Group legend="serving">
				<TextField
					label="default html to serve"
					value={draft.indexFiles}
					onChange={(event) => patch({ indexFiles: event.target.value })}
					disabled={draft.routing === 'spa'}
					spellCheck={false}
				/>
				<Toggle
					className="flex pt-2"
					checked={draft.cleanUrls}
					onChange={(event) => patch({ cleanUrls: event.target.checked })}
					label="clean urls"
					hint="/about serves /about.html or /about/index.html"
				/>
				<Toggle
					className="flex"
					checked={draft.cors}
					onChange={(event) => patch({ cors: event.target.checked })}
					label="cors"
					hint="let other origins fetch from this site"
				/>
				{draft.cors && (
					<TextField
						label="allowed origin"
						hint="* for any origin, or one like https://example.com"
						className="ml-9 max-w-sm"
						value={draft.corsOrigin}
						onChange={(event) => patch({ corsOrigin: event.target.value })}
					/>
				)}
			</Group>
		</form>
	)
}
