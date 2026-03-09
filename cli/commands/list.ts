import type { OutputSchema as DomainListOutput } from '@wispplace/lexicons/types/place/wisp/v2/domain/getList'
import type { OutputSchema as SiteListOutput } from '@wispplace/lexicons/types/place/wisp/v2/site/getList'
import { authenticateForXrpc, type XrpcCommandOptions } from '../lib/command-utils.ts'
import { createSpinner, pc } from '../lib/progress.ts'
import { callWispXrpc } from '../lib/xrpc.ts'

export type ListCommandOptions = XrpcCommandOptions

function renderDomainList(data: DomainListOutput): void {
	const { domains } = data

	if (domains.length === 0) {
		console.log(pc.dim('No domains found.'))
		return
	}

	console.log(pc.bold(`Domains (${domains.length})`))
	for (const domain of domains) {
		const statusColor = domain.status === 'verified' ? pc.green : pc.yellow
		const mappedSite = domain.siteRkey ? ` -> ${domain.siteRkey}` : ''
		console.log(`- ${pc.bold(domain.domain)} [${domain.kind}] ${statusColor(domain.status)}${mappedSite}`)
	}
}

function renderSiteList(data: SiteListOutput): void {
	const { sites } = data

	if (sites.length === 0) {
		console.log(pc.dim('No sites found.'))
		return
	}

	console.log(pc.bold(`Sites (${sites.length})`))
	for (const site of sites) {
		const title = site.displayName ? `${site.siteRkey} (${site.displayName})` : site.siteRkey
		console.log(`- ${pc.bold(title)}`)

		if (site.domains.length === 0) {
			console.log(pc.dim('  (no mapped domains)'))
			continue
		}

		for (const domain of site.domains) {
			const statusColor = domain.status === 'verified' ? pc.green : pc.yellow
			console.log(`  ${domain.domain} [${domain.kind}] ${statusColor(domain.status)}`)
		}
	}
}

export async function listDomains(identifier: string | undefined, options: ListCommandOptions): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, 'place.wisp.v2.domain.getList', options)

	const fetchSpinner = createSpinner('Fetching domains...').start()
	const data = await callWispXrpc<DomainListOutput>(agent, 'place.wisp.v2.domain.getList', {
		serviceDid,
	})
	fetchSpinner.succeed('Fetched domains')

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	renderDomainList(data)
}

export async function listSites(identifier: string | undefined, options: ListCommandOptions): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, 'place.wisp.v2.site.getList', options)

	const fetchSpinner = createSpinner('Fetching sites...').start()
	const data = await callWispXrpc<SiteListOutput>(agent, 'place.wisp.v2.site.getList', {
		serviceDid,
	})
	fetchSpinner.succeed('Fetched sites')

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	renderSiteList(data)
}
