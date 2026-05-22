import type { OutputSchema as DomainAddSiteOutput } from '@wispplace/lexicons/types/place/wisp/v2/domain/addSite'
import type { OutputSchema as DomainClaimOutput } from '@wispplace/lexicons/types/place/wisp/v2/domain/claim'
import type { OutputSchema as DomainClaimSubdomainOutput } from '@wispplace/lexicons/types/place/wisp/v2/domain/claimSubdomain'
import type { OutputSchema as DomainDeleteOutput } from '@wispplace/lexicons/types/place/wisp/v2/domain/delete'
import type { OutputSchema as DomainGetStatusOutput } from '@wispplace/lexicons/types/place/wisp/v2/domain/getStatus'
import type { OutputSchema as DomainVerifyOutput } from '@wispplace/lexicons/types/place/wisp/v2/domain/verify'
import type { OutputSchema as SiteDeleteOutput } from '@wispplace/lexicons/types/place/wisp/v2/site/delete'
import { authenticateForXrpc, type XrpcCommandOptions } from '../lib/command-utils.ts'
import { createSpinner, pc } from '../lib/progress.ts'
import { callWispXrpc } from '../lib/xrpc.ts'

export type DomainCommandOptions = XrpcCommandOptions

export async function claimCustomDomain(
	identifier: string | undefined,
	domain: string,
	siteRkey: string | undefined,
	options: DomainCommandOptions,
): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, options)

	const spinner = createSpinner(`Claiming ${domain}...`).start()
	const data = await callWispXrpc<DomainClaimOutput>(agent, 'place.wisp.v2.domain.claim', {
		serviceDid,
		data: siteRkey ? { domain, siteRkey } : { domain },
	})
	spinner.succeed(`Claimed ${data.domain}`)

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	console.log(`${pc.bold(data.domain)} -> ${data.status}`)
	if (data.txtName && data.txtValue) {
		console.log(`TXT: ${data.txtName} = ${data.txtValue}`)
	}
	if (data.cnameTarget) {
		console.log(`CNAME: ${data.cnameTarget}`)
	}
	if (data.siteRkey) {
		console.log(`Mapped site: ${data.siteRkey}`)
	}
}

export async function claimWispSubdomain(
	identifier: string | undefined,
	subdomain: string,
	siteRkey: string | undefined,
	options: DomainCommandOptions,
): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, options)

	const spinner = createSpinner(`Claiming subdomain ${subdomain}...`).start()
	const data = await callWispXrpc<DomainClaimSubdomainOutput>(agent, 'place.wisp.v2.domain.claimSubdomain', {
		serviceDid,
		data: siteRkey ? { handle: subdomain, siteRkey } : { handle: subdomain },
	})
	spinner.succeed(`Claimed ${data.domain}`)

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	console.log(`${pc.bold(data.domain)} -> ${data.status}`)
	if (data.siteRkey) {
		console.log(`Mapped site: ${data.siteRkey}`)
	}
}

export async function getDomainStatus(
	identifier: string | undefined,
	domain: string,
	options: DomainCommandOptions,
): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, options)

	const spinner = createSpinner(`Fetching status for ${domain}...`).start()
	const data = await callWispXrpc<DomainGetStatusOutput>(agent, 'place.wisp.v2.domain.getStatus', {
		serviceDid,
		params: { domain },
	})
	spinner.succeed(`Fetched status for ${data.domain}`)

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	console.log(`${pc.bold(data.domain)} -> ${data.status}`)
	if (data.kind) {
		console.log(`Kind: ${data.kind}`)
	}
	if (typeof data.verified === 'boolean') {
		console.log(`Verified: ${data.verified}`)
	}
	if (data.siteRkey) {
		console.log(`Mapped site: ${data.siteRkey}`)
	}
	if (data.lastCheckedAt) {
		console.log(`Last checked: ${data.lastCheckedAt}`)
	}
	if (data.lastError) {
		console.log(`Last error: ${data.lastError}`)
	}
}

export async function mapDomainToSite(
	identifier: string | undefined,
	domain: string,
	siteRkey: string,
	options: DomainCommandOptions,
): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, options)

	const spinner = createSpinner(`Mapping ${domain} -> ${siteRkey}...`).start()
	const data = await callWispXrpc<DomainAddSiteOutput>(agent, 'place.wisp.v2.domain.addSite', {
		serviceDid,
		data: { domain, siteRkey },
	})
	spinner.succeed(`Mapped ${data.domain}`)

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	console.log(`${pc.bold(data.domain)} -> ${data.siteRkey} (${data.status})`)
}

export async function deleteDomain(
	identifier: string | undefined,
	domain: string,
	options: DomainCommandOptions,
): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, options)

	const spinner = createSpinner(`Deleting ${domain}...`).start()
	const data = await callWispXrpc<DomainDeleteOutput>(agent, 'place.wisp.v2.domain.delete', {
		serviceDid,
		data: { domain },
	})
	spinner.succeed(`Deleted ${data.domain}`)

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	console.log(`${pc.bold(data.domain)} deleted`)
}

export async function verifyDomain(
	identifier: string | undefined,
	domain: string,
	options: DomainCommandOptions,
): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, options)

	const spinner = createSpinner(`Verifying ${domain}...`).start()
	const data = await callWispXrpc<DomainVerifyOutput>(agent, 'place.wisp.v2.domain.verify', {
		serviceDid,
		data: { domain },
	})

	if (data.verified) {
		spinner.succeed(`Verified ${data.domain}`)
	} else {
		spinner.fail(`${data.domain} not verified${data.error ? `: ${data.error}` : ''}`)
	}

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	console.log(`${pc.bold(data.domain)} ${data.verified ? pc.green('verified') : pc.yellow(data.status)}`)
	if (data.warning) {
		console.log(pc.yellow(`warning: ${data.warning}`))
	}
}

export async function deleteSite(
	identifier: string | undefined,
	siteRkey: string,
	options: DomainCommandOptions,
): Promise<void> {
	const { agent, serviceDid } = await authenticateForXrpc(identifier, options)

	const spinner = createSpinner(`Deleting site ${siteRkey}...`).start()
	const data = await callWispXrpc<SiteDeleteOutput>(agent, 'place.wisp.v2.site.delete', {
		serviceDid,
		data: { siteRkey },
	})
	spinner.succeed(`Deleted site ${data.siteRkey}`)

	if (options.json) {
		console.log(JSON.stringify(data, null, 2))
		return
	}

	console.log(`${pc.bold(data.siteRkey)} deleted`)
	if (data.unmappedDomains.length > 0) {
		console.log('Unmapped domains:')
		for (const domain of data.unmappedDomains) {
			console.log(`- ${domain.domain} [${domain.kind}] ${domain.status}`)
		}
	}
}
