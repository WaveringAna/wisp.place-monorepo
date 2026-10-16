/**
 * Main server entry point for the hosting service
 * Handles routing and request dispatching
 */

import { isPreviewHostname, parsePreviewHostname } from '@wispplace/constants'
import { normalizeSitePath } from '@wispplace/fs-utils'
import {
	CLIENT_CLOSED_REQUEST_STATUS,
	createLogger,
	type HostingNotFoundReason,
	isClientAbort,
	metricsCollector,
} from '@wispplace/observability'
import { observabilityErrorHandler, observabilityMiddleware } from '@wispplace/observability/middleware/hono'
import { siteIdFromHostname } from '@wispplace/private-sites'
import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { type CacheInvalidationHealthSnapshot, getCacheInvalidationHealthSnapshot } from './lib/cache-invalidation'
import { cache } from './lib/cache-manager'
import { getCustomDomain, getCustomDomainByHash, getWispDomain } from './lib/db'
import { serveFromCache, serveFromCacheWithRewrite } from './lib/file-serving'
import { takedownResponse } from './lib/moderation'
import { notFoundLog } from './lib/not-found-log'
import { privateNotFound, servePrivateSite } from './lib/private-serving'
import { decodeRequestPathname, extractHeaders, isValidRkey } from './lib/request-utils'
import { notFoundRecorder, requestVisibility, tagNotFound, tagSiteNotFound } from './lib/request-visibility'
import { recordSiteResponse } from './lib/site-metrics'
import { getStorageReadHealthSnapshot, type StorageReadHealthSnapshot } from './lib/storage'
import { takedowns } from './lib/takedowns'
import { isValidAtprotoIdentifier, resolveDid } from './lib/utils'

const logger = createLogger('hosting-service')

function recordPublicSiteResponse(ownerDid: string, siteRkey: string, method: string, response: Response): void {
	recordSiteResponse(ownerDid, siteRkey, method, response.status, response.headers.get('content-type'))
}

function recordPublicSiteFailure(
	ownerDid: string,
	siteRkey: string,
	method: string,
	error: unknown,
	signal: AbortSignal,
): void {
	const status = isClientAbort(error, signal) ? CLIENT_CLOSED_REQUEST_STATUS : 500
	recordSiteResponse(ownerDid, siteRkey, method, status, null)
}

function trackPublicSiteResponse(
	request: Request,
	ownerDid: string,
	siteRkey: string,
	responsePromise: Promise<Response>,
	notFoundHost?: string,
): Promise<Response> {
	const { method, signal } = request
	return responsePromise
		.then((response) => {
			recordPublicSiteResponse(ownerDid, siteRkey, method, response)
			tagSiteNotFound(request, response, notFoundHost)
			return response
		})
		.then(
			(response) => response,
			(error) => {
				recordPublicSiteFailure(ownerDid, siteRkey, method, error, signal)
				throw error
			},
		)
}

async function resolveDidCached(identifier: string): Promise<string | null> {
	if (!isValidAtprotoIdentifier(identifier)) return null
	return cache.getOrFetch('handles', identifier, () => resolveDid(identifier), {
		cacheIf: (value) => value !== null,
	})
}

type PublicDomainMapping = {
	did: string
	rkey: string | null
}

const DEFAULT_BASE_HOST = 'wisp.place'
const HOSTNAME_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export function normalizeConfiguredHostname(value: string | undefined, fallback: string): string {
	const configured = value?.trim()
	if (!configured || /[/?#@]/.test(configured)) return fallback

	try {
		const url = new URL(`http://${configured}`)
		if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return fallback

		const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
		return HOSTNAME_PATTERN.test(hostname) ? hostname : fallback
	} catch {
		return fallback
	}
}

export type HostingHostConfig = {
	/** Apex the wisp subdomains are handed out under. */
	baseHost: string
	/** `sites.{baseHost}`, where every site is addressed by `{did}/{site}`. */
	sharedSitesHost: string
	/** Apex private sites live on. Separate origin keeps tenant JS and ambient cookies isolated. */
	privateHost: string
	/** Apex previews live on, or null when previews are disabled. */
	previewHost: string | null
}

/**
 * Resolve every hostname the router branches on, from one environment object.
 *
 * The router branches on these once per request, so they are resolved once per
 * process below. This stays a pure function so tests can vary hosts without
 * mutating `process.env` ahead of an import: reading these at module scope made
 * the suite's result depend on whether the developer running it happened to have
 * a local `.env` setting BASE_HOST or PRIVATE_HOST, which CI never has.
 */
export function resolveHostConfig(env: NodeJS.ProcessEnv = process.env): HostingHostConfig {
	const baseHost = normalizeConfiguredHostname(env.BASE_HOST, DEFAULT_BASE_HOST)
	return {
		baseHost,
		sharedSitesHost: `sites.${baseHost}`,
		privateHost: normalizeConfiguredHostname(env.PRIVATE_HOST, `priv.${baseHost}`),
		// Preview deploys need a registrable domain of their own, so there is no
		// default: unset disables them.
		previewHost: normalizeConfiguredHostname(env.PREVIEW_HOST, '') || null,
	}
}

type DomainLookup = (key: string) => Promise<PublicDomainMapping | null>

/** Everything the router reaches outside itself: hosts, domain lookups, site serving and visibility sinks. */
export type HostingAppDeps = {
	hosts: HostingHostConfig
	getWispDomain: DomainLookup
	getCustomDomain: DomainLookup
	getCustomDomainByHash: DomainLookup
	serveFromCache: typeof serveFromCache
	serveFromCacheWithRewrite: typeof serveFromCacheWithRewrite
	/** Whether the moderation labeler has taken this site or its account down. */
	isTakenDown: (did: string, rkey: string) => boolean
	metrics: Pick<typeof metricsCollector, 'recordHostingResponse' | 'recordHostingNotFound'>
	notFoundLog: Pick<typeof notFoundLog, 'record'>
}

type NotFound = { reason: HostingNotFoundReason; message: string }

const CUSTOM_DOMAIN_MISSING: NotFound = {
	reason: 'unknown-custom-domain',
	message: 'Custom domain not found or not verified',
}
const SUBDOMAIN_MISSING: NotFound = { reason: 'unregistered-subdomain', message: 'Subdomain not registered' }
const DOMAIN_UNMAPPED: NotFound = { reason: 'unmapped-domain', message: 'Domain not mapped to a site' }
const PREVIEW_MISSING: NotFound = { reason: 'preview-not-found', message: 'Preview not found' }

function notFound(c: Context, { reason, message }: NotFound): Response {
	tagNotFound(c.req.raw, reason)
	return c.text(message, 404)
}

async function serveMappedPublicDomain(
	deps: HostingAppDeps,
	c: Context,
	domain: PublicDomainMapping | null,
	path: string,
	missing: NotFound,
): Promise<Response> {
	if (!domain) {
		return notFound(c, missing)
	}

	if (!domain.rkey) {
		return notFound(c, DOMAIN_UNMAPPED)
	}

	if (!isValidRkey(domain.rkey)) {
		return c.text('Invalid site configuration', 500)
	}

	if (deps.isTakenDown(domain.did, domain.rkey)) return takedownResponse(c.req.method)

	const headers = extractHeaders(c.req.raw.headers)
	return trackPublicSiteResponse(
		c.req.raw,
		domain.did,
		domain.rkey,
		deps.serveFromCache(domain.did, domain.rkey, path, c.req.url, headers, {
			method: c.req.method,
			signal: c.req.raw.signal,
		}),
	)
}

/**
 * Build the constant-time hosting health response without issuing disk or S3 I/O.
 *
 * @param snapshot Cache-invalidation connection state
 * @param configured Whether Redis invalidation is configured
 * @param storageSnapshot Safe public cold-tier read-health state
 * @returns Compact liveness/readiness state
 */
export function getCacheInvalidationHealthResponse(
	snapshot: CacheInvalidationHealthSnapshot,
	configured: boolean,
	storageSnapshot: StorageReadHealthSnapshot = getStorageReadHealthSnapshot(),
) {
	const replayHealthy = snapshot.replayConnected && snapshot.replayState === 'healthy'
	// Fail closed: the live pub/sub subscriber and the replay tail must both be
	// attached before invalidation can be called healthy. Reporting 'ok' with a
	// dead subscriber hides live-path outages behind replay's fallback.
	const subscriberHealthy = snapshot.subscriberConnected
	const storageHealthy = storageSnapshot.status === 'healthy' || storageSnapshot.status === 'not-configured'

	return {
		status: (!configured || (subscriberHealthy && replayHealthy)) && storageHealthy ? 'ok' : 'degraded',
		cacheInvalidation: {
			configured,
			subscriberConnected: snapshot.subscriberConnected,
			replayConnected: snapshot.replayConnected,
			replayState: snapshot.replayState,
			retrying: snapshot.retrying,
			gapCount: snapshot.gapCount,
			lastGapAt: snapshot.lastGapAt,
			lastGapRecoveryAt: snapshot.lastGapRecoveryAt,
			subscriberRecreations: snapshot.subscriberRecreations,
		},
		storage: {
			configured: storageSnapshot.configured,
			status: storageSnapshot.status,
			breaker: storageSnapshot.breaker,
			consecutiveFailures: storageSnapshot.consecutiveFailures,
			circuitRejections: storageSnapshot.circuitRejections,
			lastSuccessAgeMs: storageSnapshot.lastSuccessAgeMs,
			lastErrorKind: storageSnapshot.lastErrorKind,
		},
	}
}

type SiteRequest = {
	url: URL
	hostname: string
	normalizedPath: string
	publicPath: string
}

type SiteRequestFailure = 'invalidUrlEncoding' | 'invalidPath'
type SiteRequestParseResult = { kind: 'valid'; request: SiteRequest } | { kind: SiteRequestFailure }

type SharedSitePath = {
	identifier: string
	site: string
	filePath: string
}

type SharedSiteError = 'invalidPathFormat' | 'invalidIdentifier' | 'siteNameRequired' | 'invalidSiteName'
type DnsHashHostname = { hash: string; baseDomain: string }

const SITE_REQUEST_ERROR_MESSAGES = {
	invalidUrlEncoding: 'Invalid URL encoding',
	invalidPath: 'Invalid path',
} satisfies Record<SiteRequestFailure, string>

const SHARED_SITE_ERROR_MESSAGES = {
	invalidPathFormat: 'Invalid path format. Expected: /identifier/sitename/path',
	invalidIdentifier: 'Invalid identifier',
	siteNameRequired: 'Site name required',
	invalidSiteName: 'Invalid site name',
} satisfies Record<SharedSiteError, string>

function parseSiteRequest(requestUrl: string): SiteRequestParseResult {
	const url = new URL(requestUrl)
	const decodedPathname = decodeRequestPathname(url.pathname)
	if (decodedPathname === null) return { kind: 'invalidUrlEncoding' }
	if (!decodedPathname.startsWith('/')) return { kind: 'invalidPath' }

	const rawPath = decodedPathname.slice(1)
	const normalizedPath = normalizeSitePath(rawPath, { allowTrailingSlash: true })
	if (normalizedPath === null) return { kind: 'invalidPath' }

	const publicPath = rawPath.endsWith('/') && normalizedPath ? `${normalizedPath}/` : normalizedPath
	return {
		kind: 'valid',
		request: { url, hostname: url.hostname.toLowerCase().replace(/\.$/, ''), normalizedPath, publicPath },
	}
}

function siteRequestErrorResponse(c: Context, error: SiteRequestFailure): Response {
	return c.text(SITE_REQUEST_ERROR_MESSAGES[error], 400)
}

function parseSharedSitePath(normalizedPath: string): SharedSitePath | null {
	const pathParts = normalizedPath.split('/')
	if (pathParts.length < 2) return null
	return {
		identifier: pathParts[0] ?? '',
		site: pathParts[1] ?? '',
		filePath: pathParts.slice(2).join('/'),
	}
}

function validateSharedSitePath(sitePath: SharedSitePath): SharedSiteError | null {
	if (!isValidAtprotoIdentifier(sitePath.identifier)) return 'invalidIdentifier'
	if (!sitePath.site) return 'siteNameRequired'
	if (!isValidRkey(sitePath.site)) return 'invalidSiteName'
	return null
}

function sharedSiteErrorResponse(c: Context, error: SharedSiteError): Response {
	return c.text(SHARED_SITE_ERROR_MESSAGES[error], 400)
}

function needsSharedSiteRootRedirect(request: SiteRequest, sitePath: SharedSitePath): boolean {
	return !sitePath.filePath && !request.url.pathname.endsWith('/')
}

function serveSharedSiteFile(
	deps: HostingAppDeps,
	c: Context,
	sitePath: SharedSitePath,
	did: string,
): Promise<Response> {
	logger.debug(
		`sites.wisp.place request: identifier=${sitePath.identifier}, site=${sitePath.site}, filePath=${sitePath.filePath}`,
	)
	if (deps.isTakenDown(did, sitePath.site)) return Promise.resolve(takedownResponse(c.req.method))
	const basePath = `/${sitePath.identifier}/${sitePath.site}/`
	logger.debug(`Serving with basePath: ${basePath}`)
	const headers = extractHeaders(c.req.raw.headers)
	return trackPublicSiteResponse(
		c.req.raw,
		did,
		sitePath.site,
		deps.serveFromCacheWithRewrite(did, sitePath.site, sitePath.filePath, basePath, c.req.url, headers, {
			method: c.req.method,
			signal: c.req.raw.signal,
		}),
		`${deps.hosts.sharedSitesHost}/${sitePath.identifier}/${sitePath.site}`,
	)
}

async function serveSharedSite(deps: HostingAppDeps, c: Context, request: SiteRequest): Promise<Response> {
	const sitePath = parseSharedSitePath(request.normalizedPath)
	if (!sitePath) return sharedSiteErrorResponse(c, 'invalidPathFormat')

	const validationError = validateSharedSitePath(sitePath)
	if (validationError) return sharedSiteErrorResponse(c, validationError)

	const did = await resolveDidCached(sitePath.identifier)
	if (!did) return sharedSiteErrorResponse(c, 'invalidIdentifier')
	if (needsSharedSiteRootRedirect(request, sitePath))
		return c.redirect(`${request.url.pathname}/${request.url.search}`, 301)
	return serveSharedSiteFile(deps, c, sitePath, did)
}

function privateSiteResponse(
	{ privateHost }: HostingHostConfig,
	c: Context,
	request: SiteRequest,
): Response | Promise<Response> | null {
	const privateSiteId = siteIdFromHostname(request.hostname, privateHost)
	if (privateSiteId !== null) return servePrivateSite(c.req.raw, privateSiteId, request.normalizedPath)
	return request.hostname === privateHost ? privateNotFound() : null
}

async function servePrivateHost(c: Context, privateResponse: Response | Promise<Response>): Promise<Response> {
	const response = await privateResponse
	if (response.status === 404) tagNotFound(c.req.raw, 'private-not-found')
	return response
}

async function servePreviewSite(
	deps: HostingAppDeps,
	c: Context,
	request: SiteRequest,
	previewHost: string,
): Promise<Response> {
	const preview = parsePreviewHostname(request.hostname, previewHost)
	if (!preview) return notFound(c, PREVIEW_MISSING)

	const owner = await deps.getWispDomain(`${preview.claim}.${deps.hosts.baseHost}`)
	if (!owner) return notFound(c, PREVIEW_MISSING)
	return serveMappedPublicDomain(deps, c, { did: owner.did, rkey: preview.rkey }, request.publicPath, PREVIEW_MISSING)
}

function parseDnsHashHostname(hostname: string): DnsHashHostname | null {
	const dnsMatch = hostname.match(/^([a-f0-9]{16})\.dns\.(.+)$/)
	if (!dnsMatch) return null
	return { hash: dnsMatch[1] ?? '', baseDomain: dnsMatch[2] ?? '' }
}

async function serveDnsHashDomain(deps: HostingAppDeps, c: Context, request: SiteRequest): Promise<Response | null> {
	const dnsHostname = parseDnsHashHostname(request.hostname)
	if (!dnsHostname) return null
	if (!dnsHostname.hash) return c.text('Invalid DNS hash', 400)
	if (dnsHostname.baseDomain !== deps.hosts.baseHost) return c.text('Invalid base domain', 400)

	const customDomain = await deps.getCustomDomainByHash(dnsHostname.hash)
	return serveMappedPublicDomain(deps, c, customDomain, request.publicPath, CUSTOM_DOMAIN_MISSING)
}

async function servePublicDomain(deps: HostingAppDeps, c: Context, request: SiteRequest): Promise<Response> {
	const dnsResponse = await serveDnsHashDomain(deps, c, request)
	if (dnsResponse) return dnsResponse

	if (request.hostname.endsWith(`.${deps.hosts.baseHost}`)) {
		const domainInfo = await deps.getWispDomain(request.hostname)
		return serveMappedPublicDomain(deps, c, domainInfo, request.publicPath, SUBDOMAIN_MISSING)
	}

	const customDomain = await deps.getCustomDomain(request.hostname)
	return serveMappedPublicDomain(deps, c, customDomain, request.publicPath, CUSTOM_DOMAIN_MISSING)
}

function logSiteRequest(request: SiteRequest): void {
	logger.debug(`Request: hostname=${request.hostname} path=${request.publicPath}`)
}

async function routeSiteRequest(deps: HostingAppDeps, c: Context, request: SiteRequest): Promise<Response> {
	const { sharedSitesHost, previewHost } = deps.hosts
	logSiteRequest(request)
	const privateResponse = privateSiteResponse(deps.hosts, c, request)
	if (privateResponse) return await servePrivateHost(c, privateResponse)
	if (request.hostname === sharedSitesHost) return await serveSharedSite(deps, c, request)
	if (previewHost && isPreviewHostname(request.hostname, previewHost))
		return await servePreviewSite(deps, c, request, previewHost)
	return await servePublicDomain(deps, c, request)
}

/** Build the hosting router over its collaborators; the default export applies it to the real ones. */
export function createApp(deps: HostingAppDeps): Hono {
	const { baseHost, previewHost } = deps.hosts
	if (previewHost && (previewHost === baseHost || previewHost.endsWith(`.${baseHost}`))) {
		logger.warn(`PREVIEW_HOST ${previewHost} is under ${baseHost}; previews will share its cookie scope`)
	}

	const app = new Hono()

	// Never allow cross-origin credentialed reads of private content.
	app.use(
		'*',
		cors({
			origin: '*',
			allowMethods: ['GET', 'HEAD', 'OPTIONS'],
			allowHeaders: ['Content-Type', 'Authorization'],
			exposeHeaders: [
				'Content-Length',
				'Content-Type',
				'Content-Encoding',
				'Content-Range',
				'Accept-Ranges',
				'Cache-Control',
				'ETag',
			],
			maxAge: 86400, // 24 hours
			credentials: false,
		}),
	)

	// Add observability middleware
	app.use('*', observabilityMiddleware('hosting-service'))
	app.use(
		'*',
		requestVisibility({
			recordResponse: deps.metrics.recordHostingResponse,
			recordNotFound: notFoundRecorder(deps),
		}),
	)

	// Error handler
	app.onError(observabilityErrorHandler('hosting-service'))

	app.get('/health', (c) => {
		const response = getCacheInvalidationHealthResponse(
			getCacheInvalidationHealthSnapshot(),
			Boolean(process.env.REDIS_URL),
		)
		// Fail closed: a degraded invalidation pipeline must surface as an unhealthy
		// probe (HTTP 503), not a 200 that orchestrators read as ready.
		return c.json(response, response.status === 'ok' ? 200 : 503)
	})

	// Liveness only: the process is up and serving HTTP. Dependency readiness is
	// /health, which fails closed whenever invalidation or storage is degraded.
	app.get('/live', (c) => c.json({ status: 'ok' }))

	// Main site serving route
	app.get('/*', (c) => {
		const requestResult = parseSiteRequest(c.req.url)
		if (requestResult.kind !== 'valid') return siteRequestErrorResponse(c, requestResult.kind)
		return routeSiteRequest(deps, c, requestResult.request)
	})

	return app
}

export default createApp({
	hosts: resolveHostConfig(),
	getWispDomain,
	getCustomDomain,
	getCustomDomainByHash,
	serveFromCache,
	serveFromCacheWithRewrite,
	isTakenDown: takedowns.isTakenDown,
	metrics: metricsCollector,
	notFoundLog,
})
