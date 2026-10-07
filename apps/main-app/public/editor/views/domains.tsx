import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, Fragment, useEffect, useRef, useState } from 'react'
import {
	api,
	type CustomDomain,
	errorText,
	type MarqueEntry,
	type MarqueStatus,
	type UserInfo,
	type VerifyResult,
	type WispDomain,
} from '../api'
import { confirmAction } from '../confirm'
import { plural } from '../format'
import { rowActions, useRovingList } from '../keys'
import { keys, useAction, useDomains } from '../queries'
import { notify } from '../store'
import {
	AddLabel,
	Button,
	type Column,
	CopyButton,
	DetailRow,
	Dialog,
	Notice,
	openInNewTab,
	Row,
	RowActions,
	Section,
	Sheet,
	SkeletonRows,
	Status,
	TextField,
} from '../ui'

const FREE_SUBDOMAINS = 3

/** Regional hosting nodes, for providers that cannot point a CNAME at the apex. */
const HOSTING_NODES = [
	{ region: 'us east (virginia)', ipv4: '150.136.127.67', ipv6: '2603:c020:4025:5700:0:81b3:1abb:a401' },
	{ region: 'us west (california)', ipv4: '152.44.44.138', ipv6: '2604:ed40:1000:1711:ec1e:4bff:fef1:2e55' },
	{ region: 'europe (netherlands)', ipv4: '152.53.121.97', ipv6: '2a0a:4cc0:c0:44af:c886:d7ff:febd:2a06' },
	{ region: 'asia (singapore)', ipv4: '213.163.207.16', ipv6: '2a04:3543:1000:2310:ec1e:4bff:fef1:608b' },
] as const

const openDomain = (domain: string) => openInNewTab(`https://${domain}`)

/**
 * When to check dns after writing a marque zone. Its nameservers usually answer
 * within a second or two, but not always, so a slow one gets a few more tries.
 */
const MARQUE_CHECKS_MS = [2000, 6000, 15_000] as const

/** `?dns=<id>`, left by the sign-in that let wisp edit marque dns, reopens that domain's dialog. */
const dnsParam = (): string | null => new URLSearchParams(window.location.search).get('dns')

const WISP_COLUMNS: readonly Column[] = [
	{ name: 'subdomain' },
	{ name: 'serves', className: 'max-sm:hidden' },
	{ name: 'status' },
	{ name: 'actions', label: '' },
]

const CUSTOM_COLUMNS: readonly Column[] = [
	{ name: 'domain' },
	{ name: 'serves', className: 'max-sm:hidden' },
	{ name: 'dns' },
	{ name: 'actions', label: '' },
]

/** The site a domain points at, or a quiet "not mapped". */
const Serves = ({ site }: { site: string | null }) => (
	<td className="max-sm:hidden">{site ?? <span className="italic opacity-60">not mapped</span>}</td>
)

export function DomainsView({ user }: { user: UserInfo | undefined }) {
	const domains = useDomains()
	const [dnsFor, setDnsFor] = useState<string | null>(dnsParam)
	const [verdicts, setVerdicts] = useState<Record<string, VerifyResult>>({})

	useEffect(() => {
		const url = new URL(window.location.href)
		if (!url.searchParams.has('dns')) return
		url.searchParams.delete('dns')
		window.history.replaceState(null, '', url)
	}, [])

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
	const waiting = (domains.data?.custom ?? []).filter((domain) => !domain.verified)

	return (
		<>
			{waiting.map((domain) => (
				<div key={domain.id} className="callout" role="status">
					<span>
						<strong>{domain.domain}</strong> is waiting for dns
					</span>
					<span className="ml-auto flex gap-1">
						<Button onClick={() => setDnsFor(domain.id)}>records</Button>
						<Button busy={verify.isPending && verify.variables?.id === domain.id} onClick={() => runVerify(domain)}>
							check
						</Button>
					</span>
				</div>
			))}
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
				<Sheet
					columns={WISP_COLUMNS}
					form={
						canClaim ? <ClaimForm /> : <p className="text-ink-soft">all {FREE_SUBDOMAINS} free subdomains claimed ✦</p>
					}
				>
					{wisp.map((domain, index) => (
						<Row key={domain.domain} rowProps={rowProps(index)} onActivate={() => openDomain(domain.domain)}>
							<td className="name">{domain.domain}</td>
							<Serves site={domain.rkey} />
							<td>{domain.rkey ? <Status tone="ok">serving</Status> : <Status tone="muted">not mapped</Status>}</td>
							<RowActions>
								<Button variant="ghost" tabIndex={-1} onClick={() => openDomain(domain.domain)}>
									open
								</Button>
								<Button
									variant="danger"
									tabIndex={-1}
									busy={release.isPending && release.variables === domain.domain}
									onClick={() => askRelease(domain)}
								>
									release
								</Button>
							</RowActions>
						</Row>
					))}
				</Sheet>
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
				<Sheet columns={CUSTOM_COLUMNS} form={<AddDomainForm onAdded={onShowDns} />}>
					{custom.map((domain, index) => (
						<Fragment key={domain.id}>
							<Row rowProps={rowProps(index)} onActivate={() => onShowDns(domain.id)}>
								<td className="name">{domain.domain}</td>
								<Serves site={domain.rkey} />
								<td>
									{domain.verified ? <Status tone="ok">verified</Status> : <Status tone="warn">waiting for dns</Status>}
								</td>
								<RowActions>
									{!domain.verified && (
										<Button variant="ghost" tabIndex={-1} onClick={() => onVerify(domain)}>
											check
										</Button>
									)}
									<Button variant="ghost" tabIndex={-1} onClick={() => onShowDns(domain.id)}>
										dns
									</Button>
									<Button variant="ghost" tabIndex={-1} onClick={() => openDomain(domain.domain)}>
										open
									</Button>
									<Button
										variant="danger"
										tabIndex={-1}
										busy={remove.isPending && remove.variables?.id === domain.id}
										onClick={() => askRemove(domain)}
									>
										remove
									</Button>
								</RowActions>
							</Row>
							{verdicts[domain.id] && (
								<DetailRow id={`verdict-${domain.id}`} span={CUSTOM_COLUMNS.length}>
									<Verdict result={verdicts[domain.id]} />
								</DetailRow>
							)}
						</Fragment>
					))}
				</Sheet>
			)}
			<p className="hint mt-3">
				no domain yet?{' '}
				<a
					href="https://marque.at"
					target="_blank"
					rel="noopener"
					className="text-rose underline-offset-2 hover:underline"
				>
					marque.at ↗
				</a>{' '}
				is a registrar on atproto: sign in with this same account, and it'll integrate seamlessly with wisp.
			</p>
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
		<form onSubmit={submit} className="contents">
			<TextField
				label={<AddLabel>claim a subdomain</AddLabel>}
				className="field"
				suffix=".wisp.place"
				value={handle}
				onChange={(event) => setHandle(event.target.value)}
				placeholder="mysite"
				autoCapitalize="none"
				autoComplete="off"
				spellCheck={false}
				hint={
					<span aria-live="polite">
						{name && !settled && 'checking…'}
						{settled && available && <span className="text-ok">✓ available</span>}
						{settled && !available && (
							<span className="text-bad">
								{availability.data.reason === 'invalid' ? '✗ not a valid name' : '✗ taken'}
							</span>
						)}
						{!name && '\u00a0'}
					</span>
				}
			/>
			<Button variant="primary" type="submit" disabled={!available} busy={claim.isPending} className="mb-5">
				claim
			</Button>
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
		<form onSubmit={submit} className="contents">
			<TextField
				label={<AddLabel>add a domain you own</AddLabel>}
				className="field"
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
	const marque = useQuery({
		queryKey: keys.marque(domain?.id ?? ''),
		queryFn: () => api.marqueStatus(domain?.id ?? ''),
		enabled: domain !== undefined && !domain.verified,
		staleTime: 0,
	})
	const onMarque = domain?.verified === false && marque.data?.managed ? marque.data : null
	// Showing the copy-it-yourself steps first and swapping them out a moment later reads as a glitch.
	const checkingMarque = domain?.verified === false && marque.isPending

	const records = domain && (
		<>
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
				<summary className="cursor-pointer text-ink-soft hover:text-ink">or use A and AAAA records instead</summary>
				<Notice tone="warn">
					these skip GeoDNS: every visitor is served from the one region you pick. add both its A and AAAA.
				</Notice>
				{HOSTING_NODES.map((node) => (
					<Fragment key={node.region}>
						<Record name={`${node.region} · A`} value={node.ipv4} />
						<Record name={`${node.region} · AAAA`} value={node.ipv6} />
					</Fragment>
				))}
			</details>
		</>
	)

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
					{checkingMarque ? (
						<p className="hint">checking where its dns lives…</p>
					) : onMarque ? (
						<>
							<MarqueSetup key={domain.id} domain={domain} status={onMarque} onVerify={onVerify} />
							<details>
								<summary className="cursor-pointer text-ink-soft hover:text-ink">or add the records yourself</summary>
								<div className="mt-3 space-y-5">{records}</div>
							</details>
						</>
					) : (
						records
					)}
					<Verdict result={verdict} />
					<p className="hint">dns changes can take a few minutes to show up</p>
				</div>
			)}
		</Dialog>
	)
}

const ZoneEntry = ({ entry }: { entry: MarqueEntry }) => (
	<div className="grid grid-cols-[minmax(4rem,auto)_auto_1fr] gap-x-3 border-b border-dashed border-rule py-1.5 last:border-0">
		<span className="text-ink-soft">{entry.name}</span>
		<span className="text-ink-soft">{entry.recordType}</span>
		<code className="break-all">{entry.value}</code>
	</div>
)

interface MarqueSetupProps {
	domain: CustomDomain
	status: MarqueStatus & { managed: true }
	onVerify: (domain: CustomDomain) => void
}

/**
 * A domain marque.at serves gets its records written straight into its zone:
 * as soon as the dialog opens once wisp is allowed to, and only after asking
 * when something already sits at those names.
 */
function MarqueSetup({ domain, status, onVerify }: MarqueSetupProps) {
	const client = useQueryClient()
	const setUp = useAction((replace: boolean) => api.setUpMarque(domain.id, replace), {
		invalidates: [keys.marque(domain.id)],
		success: `added ${domain.domain} to your marque dns ✦`,
		failure: 'could not set up marque dns',
	})
	// Checks stop once the domain verifies, since the dialog then drops this panel.
	// The latest domain and callback are read through a ref: every check refetches
	// the domain list, and restarting the timers on that would check forever.
	const latest = useRef({ domain, onVerify })
	latest.current = { domain, onVerify }
	const [written, setWritten] = useState(false)
	useEffect(() => {
		if (!written) return
		const check = () => latest.current.onVerify(latest.current.domain)
		const timers = MARQUE_CHECKS_MS.map((delay) => setTimeout(check, delay))
		return () => timers.forEach(clearTimeout)
	}, [written])

	const apply = (replace: boolean) =>
		setUp.mutate(replace, {
			onSuccess: () => setWritten(true),
			// A conflict that appeared since the dialog opened is shown from a fresh status.
			onError: () => client.invalidateQueries({ queryKey: keys.marque(domain.id) }),
		})

	const ready = status.canWrite && status.state === 'ready'
	const applied = useRef(false)
	useEffect(() => {
		if (!ready || applied.current) return
		applied.current = true
		apply(false)
	})

	const askReplace = async () => {
		const confirmed = await confirmAction({
			title: `replace ${plural(status.conflicts.length, 'record')}?`,
			body: `They stop answering for ${domain.domain}. Everything else in ${status.apex}'s dns stays as it is.`,
			action: 'replace',
		})
		if (confirmed) apply(true)
	}

	return (
		<section>
			<h3 className="font-bold">{status.apex} is on marque.at</h3>
			{!status.canWrite && (
				<>
					<p className="hint mb-2">wisp can add both records to its dns for you, no copying needed.</p>
					<Button
						variant="primary"
						onClick={() => window.location.assign(`/api/auth/setup/marque?domain=${encodeURIComponent(domain.id)}`)}
					>
						let wisp edit its dns
					</Button>
				</>
			)}
			{ready &&
				(setUp.isError ? (
					<>
						<Notice tone="bad">{errorText(setUp.error)}</Notice>
						<Button variant="primary" onClick={() => apply(false)}>
							try again
						</Button>
					</>
				) : (
					<p className="hint">adding the records…</p>
				))}
			{status.canWrite && status.state === 'done' && <p className="hint text-ok">✓ both records are in its dns</p>}
			{status.canWrite && status.state === 'conflict' && (
				<>
					<p className="hint mb-1">these records are already at those names, so wisp left the dns alone:</p>
					{status.conflicts.map((entry) => (
						<ZoneEntry key={`${entry.name} ${entry.recordType} ${entry.value}`} entry={entry} />
					))}
					<Button variant="danger" className="mt-2" busy={setUp.isPending} onClick={askReplace}>
						replace them
					</Button>
				</>
			)}
		</section>
	)
}
