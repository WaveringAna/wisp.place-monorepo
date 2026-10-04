import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useEffect, useState } from 'react'
import { api, type CustomDomain, type UserInfo, type VerifyResult, type WispDomain } from '../api'
import { confirmAction } from '../confirm'
import { plural } from '../format'
import { type RowProps, rowActions, useRovingList } from '../keys'
import { keys, useAction, useDomains } from '../queries'
import { notify } from '../store'
import {
	AddLabel,
	Button,
	CopyButton,
	cx,
	Dialog,
	Notice,
	openInNewTab,
	Section,
	SkeletonRows,
	Tag,
	TextField,
} from '../ui'

const FREE_SUBDOMAINS = 3

/** Regional hosting nodes, for providers that cannot point a CNAME at the apex. */
const HOSTING_NODES = [
	{ region: 'us east (virginia)', ip: '129.213.110.75' },
	{ region: 'us west (california)', ip: '152.44.44.138' },
	{ region: 'europe (netherlands)', ip: '152.53.121.97' },
	{ region: 'asia (singapore)', ip: '213.163.207.16' },
] as const

const openDomain = (domain: string) => openInNewTab(`https://${domain}`)

interface DomainLineProps {
	domain: string
	/** The site it serves, null while it is not mapped to one. */
	site: string | null
	/** False for a custom domain whose dns has not been verified yet. */
	verified?: boolean
	rowProps: RowProps
	onClick: () => void
}

/** One domain on one line: a status dot, the name, the site it serves, and a tag only when dns needs attention. */
const DomainLine = ({ domain, site, verified = true, rowProps, onClick }: DomainLineProps) => (
	<button type="button" {...rowProps} className="row-line" onClick={onClick}>
		<span
			className={cx('shrink-0 text-xs', verified && site ? 'text-ok' : verified ? 'text-ink-soft' : 'text-warn')}
			aria-hidden="true"
		>
			{verified && site ? '●' : '○'}
		</span>
		<span className="min-w-0 truncate font-bold">{domain}</span>
		{!verified && <Tag tone="butter">waiting for dns</Tag>}
		<span className="flex-1" />
		<span
			className={cx(
				'w-44 shrink-0 truncate text-right max-sm:hidden',
				site ? 'text-ink-soft' : 'text-ink-soft/60 italic',
			)}
		>
			{site ? `→ ${site}` : 'no site yet'}
		</span>
	</button>
)

export function DomainsView({ user }: { user: UserInfo | undefined }) {
	const domains = useDomains()
	const [dnsFor, setDnsFor] = useState<string | null>(null)
	const [verdicts, setVerdicts] = useState<Record<string, VerifyResult>>({})

	const verify = useAction((domain: CustomDomain) => api.verifyCustomDomain(domain.id), {
		invalidates: [keys.domains],
		failure: 'could not check dns',
	})

	const runVerify = (domain: CustomDomain) =>
		verify.mutate(domain, {
			onSuccess: (result) => {
				setVerdicts((previous) => ({ ...previous, [domain.id]: result }))
				if (result.verified) notify.ok(`${domain.domain} verified ✓`)
			},
		})

	const viewing = domains.data?.custom.find((domain) => domain.id === dnsFor)

	return (
		<>
			<WispDomains supporter={user?.isSupporter ?? false} />
			<CustomDomains verdicts={verdicts} onVerify={runVerify} onShowDns={setDnsFor} />
			<DnsDialog
				domain={viewing}
				did={user?.did}
				verifying={verify.isPending}
				verdict={viewing && verdicts[viewing.id]}
				onVerify={runVerify}
				onClose={() => setDnsFor(null)}
			/>
		</>
	)
}

function WispDomains({ supporter }: { supporter: boolean }) {
	const domains = useDomains()
	const wisp = domains.data?.wisp ?? []

	const release = useAction(api.deleteWispDomain, {
		invalidates: [keys.domains, keys.sites],
		success: (_, domain) => `released ${domain}`,
		failure: 'could not remove domain',
	})

	const askRelease = async (domain: WispDomain) => {
		const confirmed = await confirmAction({
			title: `release ${domain.domain}?`,
			body: 'Someone else could claim it afterwards.',
			action: 'release',
		})
		if (confirmed) release.mutate(domain.domain)
	}

	const rowProps = useRovingList(
		wisp.length,
		rowActions(wisp, { o: (domain) => openDomain(domain.domain), d: askRelease }),
	)
	const canClaim = wisp.length < FREE_SUBDOMAINS || supporter

	return (
		<Section
			title="wisp.place subdomains"
			meta={domains.data && (supporter ? `${wisp.length} claimed` : `${wisp.length}/${FREE_SUBDOMAINS} free`)}
		>
			{domains.isPending && <SkeletonRows count={2} />}
			{domains.isError && <Notice tone="bad">could not load domains: {domains.error.message}</Notice>}
			{domains.isSuccess && (
				<ul className="rows">
					{wisp.map((domain, index) => (
						<li key={domain.domain}>
							<DomainLine
								domain={domain.domain}
								site={domain.rkey}
								rowProps={rowProps(index)}
								onClick={() => openDomain(domain.domain)}
							/>
						</li>
					))}
					<li className="row-form">
						{canClaim ? (
							<ClaimForm />
						) : (
							<p className="text-ink-soft">all {FREE_SUBDOMAINS} free subdomains claimed ✦</p>
						)}
					</li>
				</ul>
			)}
		</Section>
	)
}

interface CustomDomainsProps {
	verdicts: Record<string, VerifyResult>
	onVerify: (domain: CustomDomain) => void
	onShowDns: (id: string) => void
}

function CustomDomains({ verdicts, onVerify, onShowDns }: CustomDomainsProps) {
	const domains = useDomains()
	const custom = domains.data?.custom ?? []

	const remove = useAction((domain: CustomDomain) => api.deleteCustomDomain(domain.id), {
		invalidates: [keys.domains, keys.sites],
		success: (_, domain) => `removed ${domain.domain}`,
		failure: 'could not remove domain',
	})

	const askRemove = async (domain: CustomDomain) => {
		const confirmed = await confirmAction({
			title: `remove ${domain.domain}?`,
			body: 'It stops serving your site. Your DNS records are left alone.',
			action: 'remove',
		})
		if (confirmed) remove.mutate(domain)
	}

	const rowProps = useRovingList(
		custom.length,
		rowActions(custom, {
			o: (domain) => openDomain(domain.domain),
			v: (domain) => !domain.verified && onVerify(domain),
			d: askRemove,
		}),
	)

	return (
		<Section title="custom domains" meta={domains.data && plural(custom.length, 'domain')}>
			{domains.isPending && <SkeletonRows count={2} />}
			{domains.isSuccess && (
				<ul className="rows">
					{custom.map((domain, index) => (
						<li key={domain.id}>
							<DomainLine
								domain={domain.domain}
								site={domain.rkey}
								verified={domain.verified}
								rowProps={rowProps(index)}
								onClick={() => onShowDns(domain.id)}
							/>
							<div className="pr-4 pb-2 pl-8 empty:hidden">
								<Verdict result={verdicts[domain.id]} />
							</div>
						</li>
					))}
					<li className="row-form">
						<AddDomainForm onAdded={onShowDns} />
					</li>
				</ul>
			)}
		</Section>
	)
}

function Verdict({ result }: { result: VerifyResult | undefined }) {
	if (!result) return null
	if (!result.verified)
		return <Notice tone="bad">{result.error ?? 'records not found yet, dns can take a few minutes'}</Notice>
	return result.warning ? <Notice tone="warn">{result.warning}</Notice> : null
}

function useDebouncedValue<T>(value: T, delay: number): T {
	const [debounced, setDebounced] = useState(value)
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(value), delay)
		return () => clearTimeout(timer)
	}, [value, delay])
	return debounced
}

function ClaimForm() {
	const [handle, setHandle] = useState('')
	const name = handle.trim().toLowerCase()
	const checked = useDebouncedValue(name, 300)
	const availability = useQuery({
		queryKey: keys.wispAvailability(checked),
		queryFn: () => api.checkWispDomain(checked),
		enabled: checked !== '',
		staleTime: 10_000,
	})
	const claim = useAction(api.claimWispDomain, {
		invalidates: [keys.domains],
		success: (_, claimed) => `claimed ${claimed}.wisp.place ✦`,
		failure: 'could not claim',
	})

	const settled = name === checked && availability.isSuccess && !availability.isFetching
	const available = settled && availability.data.available

	const submit = (event: FormEvent) => {
		event.preventDefault()
		if (available) claim.mutate(name, { onSuccess: () => setHandle('') })
	}

	return (
		<form onSubmit={submit} className="flex flex-wrap items-center gap-x-3 gap-y-2">
			<TextField
				label={<AddLabel>claim a subdomain</AddLabel>}
				inline
				className="min-w-0 flex-1"
				suffix=".wisp.place"
				value={handle}
				onChange={(event) => setHandle(event.target.value)}
				placeholder="mysite"
				autoCapitalize="none"
				autoComplete="off"
				spellCheck={false}
			/>
			<Button variant="primary" type="submit" disabled={!available} busy={claim.isPending}>
				claim
			</Button>
			<span className="text-xs" aria-live="polite">
				{name && !settled && <span className="text-ink-soft">checking…</span>}
				{settled && available && <span className="text-ok">✓ available</span>}
				{settled && !available && (
					<span className="text-bad">{availability.data.reason === 'invalid' ? '✗ not a valid name' : '✗ taken'}</span>
				)}
			</span>
		</form>
	)
}

function AddDomainForm({ onAdded }: { onAdded: (id: string) => void }) {
	const add = useAction(api.addCustomDomain, {
		invalidates: [keys.domains],
		success: (_, domain) => `added ${domain}, now set up its dns`,
		failure: 'could not add domain',
	})

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const form = event.currentTarget
		const domain = String(new FormData(form).get('domain') ?? '').trim()
		if (!domain) return
		add.mutate(domain, {
			onSuccess: ({ id }) => {
				form.reset()
				onAdded(id)
			},
		})
	}

	return (
		<form onSubmit={submit} className="flex flex-wrap items-center gap-x-3 gap-y-2">
			<TextField
				label={<AddLabel>add a domain you own</AddLabel>}
				inline
				className="min-w-0 flex-1"
				name="domain"
				placeholder="example.com"
				autoCapitalize="none"
				spellCheck={false}
				required
			/>
			<Button variant="primary" type="submit" busy={add.isPending}>
				add
			</Button>
		</form>
	)
}

const Record = ({ name, value }: { name: string; value: string }) => (
	<div className="grid grid-cols-[minmax(4rem,auto)_1fr_auto] items-center gap-x-3 border-b border-dashed border-rule py-1.5 last:border-0">
		<span className="text-ink-soft">{name}</span>
		<code className="break-all">{value}</code>
		<CopyButton text={value} />
	</div>
)

interface DnsDialogProps {
	domain: CustomDomain | undefined
	did: string | undefined
	verifying: boolean
	verdict: VerifyResult | undefined
	onVerify: (domain: CustomDomain) => void
	onClose: () => void
}

function DnsDialog({ domain, did, verifying, verdict, onVerify, onClose }: DnsDialogProps) {
	return (
		<Dialog
			open={domain !== undefined}
			onClose={onClose}
			title={`dns for ${domain?.domain ?? ''}`}
			footer={
				domain && (
					<>
						<span className={domain.verified ? 'text-ok' : 'text-warn'}>
							{domain.verified ? '● verified' : '○ not verified yet'}
						</span>
						<Button variant="ghost" className="ml-auto" onClick={onClose}>
							close
						</Button>
						<Button variant="primary" busy={verifying} onClick={() => onVerify(domain)} data-autofocus>
							check dns
						</Button>
					</>
				)
			}
		>
			{domain && (
				<div className="space-y-5">
					<section>
						<h3 className="font-bold">1 · prove it is yours</h3>
						<p className="hint mb-1">add a TXT record</p>
						<Record name="name" value={`_wisp.${domain.domain}`} />
						<Record name="value" value={did ?? '…'} />
					</section>
					<section>
						<h3 className="font-bold">2 · point it here</h3>
						<p className="hint mb-1">add a CNAME record, which keeps GeoDNS routing visitors to the nearest node</p>
						<Record name="name" value={domain.domain} />
						<Record name="value" value={`${domain.id}.dns.wisp.place`} />
						<p className="hint mt-1">providers that flatten CNAMEs into A records (like cloudflare) are fine</p>
					</section>
					<details>
						<summary className="cursor-pointer text-ink-soft hover:text-ink">or use an A record instead</summary>
						<Notice tone="warn">A records skip GeoDNS: every visitor is served from the one region you pick.</Notice>
						{HOSTING_NODES.map((node) => (
							<Record key={node.ip} name={node.region} value={node.ip} />
						))}
					</details>
					<Verdict result={verdict} />
					<p className="hint">dns changes can take a few minutes to show up</p>
				</div>
			)}
		</Dialog>
	)
}
