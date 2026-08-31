import {
	privateSiteUrl as buildPrivateSiteUrl,
	privateGrantUrlFor,
	privateShareLinkUrl,
} from '@wispplace/private-sites'

const HOSTNAME_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export interface PrivateHostConfiguration {
	host: string
	hostname: string
}

const parsePrivateHost = (value: string | undefined): PrivateHostConfiguration | null => {
	const configured = value?.trim()
	if (!configured || /[/?#@]/.test(configured)) return null

	try {
		// PRIVATE_HOST is a host[:port], not an origin. This deliberately matches
		// hosting-service's configured-host parser so the two services route the same names.
		const url = new URL(`http://${configured}`)
		if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null

		const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
		if (!HOSTNAME_PATTERN.test(hostname)) return null

		return {
			host: url.port ? `${hostname}:${url.port}` : hostname,
			hostname,
		}
	} catch {
		return null
	}
}

/**
 * Safely normalize a configured private host. `host` retains a non-default port
 * for local browser links; `hostname` is the port-free DNS name used for routing
 * and certificate checks.
 */
export const normalizePrivateHost = (value: string | undefined, fallback: string): PrivateHostConfiguration =>
	parsePrivateHost(value) ?? parsePrivateHost(fallback) ?? { host: 'priv.wisp.place', hostname: 'priv.wisp.place' }

const BASE_HOST = normalizePrivateHost(process.env.BASE_HOST || process.env.BASE_DOMAIN, 'wisp.place').hostname
const privateHostConfiguration = (): PrivateHostConfiguration =>
	normalizePrivateHost(process.env.PRIVATE_HOST, `priv.${BASE_HOST}`)

export const privateHost = (): string => privateHostConfiguration().host
export const privateHostname = (): string => privateHostConfiguration().hostname

// process.env.NODE_ENV is inlined by `bun build --compile` at image build time, so the
// scheme must key off LOCAL_DEV (a runtime-only read) to stay https in production binaries.
const scheme = (): 'http' | 'https' => (process.env.LOCAL_DEV === 'true' ? 'http' : 'https')
export const privateSiteUrl = (siteId: string): string => buildPrivateSiteUrl(siteId, privateHost(), scheme())
export const privateOwnerUrl = (siteId: string, handoff: string): string =>
	privateGrantUrlFor(privateSiteUrl(siteId), handoff)
export const privateShareUrl = (siteId: string, token: string): string =>
	privateShareLinkUrl(privateSiteUrl(siteId), token)
export const shortShareUrl = (token: string): string => {
	const base = (process.env.MAIN_APP_URL || process.env.DOMAIN || `https://${BASE_HOST}`).replace(/\/+$/, '')
	return `${base}/p/${encodeURIComponent(token)}`
}
