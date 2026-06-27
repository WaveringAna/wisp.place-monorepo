import { buildWispSiteUrl } from '@wispplace/standard-site'
import { getDomainsBySite } from './db'

export interface SiteDomainMapping {
	type: 'wisp' | 'custom'
	domain: string
	verified?: boolean
}

export function chooseStandardSitePublicationUrl(domains: SiteDomainMapping[], fallbackUrl: string): string {
	const customDomain = domains.find((domain) => domain.type === 'custom' && domain.verified === true)
	if (customDomain) return domainToHttpsUrl(customDomain.domain)

	const wispDomain = domains.find((domain) => domain.type === 'wisp')
	if (wispDomain) return domainToHttpsUrl(wispDomain.domain)

	return fallbackUrl
}

export async function resolveStandardSitePublicationUrl(did: string, siteRkey: string): Promise<string> {
	const fallbackUrl = buildWispSiteUrl(did, siteRkey)
	const domains = await getDomainsBySite(did, siteRkey)

	return chooseStandardSitePublicationUrl(domains, fallbackUrl)
}

function domainToHttpsUrl(domain: string): string {
	return `https://${domain.replace(/\/+$/, '')}`
}
