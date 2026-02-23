import { createHash } from 'crypto';

import { Elysia } from 'elysia';

import { CompositeDidDocumentResolver, PlcDidDocumentResolver, WebDidDocumentResolver } from '@atcute/identity-resolver';
import { json, XRPCRouter, XRPCError } from '@atcute/xrpc-server';
import { ServiceJwtVerifier } from '@atcute/xrpc-server/auth';
import {
  PlaceWispV2DomainAddSite,
  PlaceWispV2DomainClaim,
  PlaceWispV2DomainClaimSubdomain,
  PlaceWispV2DomainDelete,
  PlaceWispV2DomainGetList,
  PlaceWispV2DomainGetStatus,
  PlaceWispV2SiteDelete,
  PlaceWispV2SiteGetList,
} from '@wispplace/lexicons/atcute';
import { BASE_HOST } from '@wispplace/constants';

import { createLogger } from '@wispplace/observability';

import {
  claimCustomDomain,
  claimDomain,
  deleteCustomDomain,
  deleteSite,
  deleteWispDomain,
  getDomainsBySite,
  getAllWispDomains,
  getCustomDomainsByDid,
  getCustomDomainInfo,
  getSitesByDid,
  isDomainRegistered,
  updateCustomDomainRkey,
  updateWispDomainSite,
} from '../lib/db';
import {
  extractWispHandle,
  isValidHandle,
  normalizeDomain,
  toDomain,
  validateCustomDomain,
} from '../lib/domain-utils';

const logger = createLogger('main-app');
const isLocalDev = Bun.env.LOCAL_DEV === 'true';

interface XrpcAuthContext {
  did: string;
}

const DEFAULT_SERVICE_DID = isLocalDev ? 'did:web:localhost' : 'did:web:wisp.place';
const SERVICE_DID = Bun.env.SERVICE_DID ?? DEFAULT_SERVICE_DID;
const serviceJwtVerifier = new ServiceJwtVerifier({
  serviceDid: SERVICE_DID as any,
  resolver: new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver(),
      web: new WebDidDocumentResolver(),
    },
  }),
});

const NSID_ALIASES: Record<string, string> = {
  'place.wisp.v2.domain.add-site': 'place.wisp.v2.domain.addSite',
  'place.wisp.v2.domain.addsite': 'place.wisp.v2.domain.addSite',
  'place.wisp.v2.domain.claim-subdomain': 'place.wisp.v2.domain.claimSubdomain',
  'place.wisp.v2.domain.claimsubdomain': 'place.wisp.v2.domain.claimSubdomain',
  'place.wisp.v2.domain.claimsub-domain': 'place.wisp.v2.domain.claimSubdomain',
  'place.wisp.v2.domain.get-list': 'place.wisp.v2.domain.getList',
  'place.wisp.v2.domain.getlist': 'place.wisp.v2.domain.getList',
  'place.wisp.v2.domain.getstatus': 'place.wisp.v2.domain.getStatus',
  'place.wisp.v2.domain.get-status': 'place.wisp.v2.domain.getStatus',
  'place.wisp.v2.site.delete-site': 'place.wisp.v2.site.delete',
  'place.wisp.v2.site.deletesite': 'place.wisp.v2.site.delete',
  'place.wisp.v2.site.get-list': 'place.wisp.v2.site.getList',
  'place.wisp.v2.site.getlist': 'place.wisp.v2.site.getList',
};

const XRPC_NSIDS = {
  addSite: 'place.wisp.v2.domain.addSite',
  getStatus: 'place.wisp.v2.domain.getStatus',
  getList: 'place.wisp.v2.domain.getList',
  siteGetList: 'place.wisp.v2.site.getList',
  claimSubdomain: 'place.wisp.v2.domain.claimSubdomain',
  claim: 'place.wisp.v2.domain.claim',
  delete: 'place.wisp.v2.domain.delete',
  deleteSite: 'place.wisp.v2.site.delete',
} as const;

const toIsoFromEpoch = (epoch: unknown): string | undefined => {
  let numeric: number | undefined;

  if (typeof epoch === 'number') {
    numeric = epoch;
  } else if (typeof epoch === 'string') {
    numeric = Number(epoch);
  }

  if (!Number.isFinite(numeric)) {
    return undefined;
  }

  const ms = numeric! < 1_000_000_000_000 ? numeric! * 1000 : numeric!;
  const date = new Date(ms);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
};

type DidString = `did:${string}:${string}`;

const buildCustomDnsInstructions = (domain: string, did: DidString, challengeId: string) => {
  return {
    challengeId,
    txtName: `_wisp.${domain}`,
    txtValue: did,
    cnameTarget: `${challengeId}.dns.${BASE_HOST}`,
  };
};

const authRequired = (): never => {
  throw new XRPCError({ status: 401, error: 'AuthenticationRequired', description: 'authentication required' });
};

const invalidDomain = (description: string): never => {
  throw new XRPCError({
    status: 400,
    error: 'InvalidDomain',
    description,
  });
};

const alreadyClaimed = (description: string): never => {
  throw new XRPCError({
    status: 409,
    error: 'AlreadyClaimed',
    description,
  });
};

const domainLimitReached = (): never => {
  throw new XRPCError({
    status: 400,
    error: 'DomainLimitReached',
    description: 'free tier users can claim up to 3 wisp subdomains',
  });
};

const notFound = (description = 'domain not found'): never => {
  throw new XRPCError({
    status: 404,
    error: 'NotFound',
    description,
  });
};

const invalidRequest = (description: string): never => {
  throw new XRPCError({
    status: 400,
    error: 'InvalidRequest',
    description,
  });
};

const requireAuthenticated = (auth: XrpcAuthContext | undefined): XrpcAuthContext => {
  if (!auth) {
    authRequired();
  }

  return auth!;
};

const authRequiredWith = (description: string): never => {
  throw new XRPCError({ status: 401, error: 'AuthenticationRequired', description });
};

const resolveServiceAuth = async (request: Request, nsid: string): Promise<XrpcAuthContext | undefined> => {
  const authorization = request.headers.get('authorization');
  if (!authorization) {
    return undefined;
  }

  if (!authorization.startsWith('Bearer ')) {
    authRequiredWith('missing or invalid authorization header');
  }

  const jwt = authorization.slice('Bearer '.length).trim();
  if (!jwt) {
    authRequiredWith('missing service authorization token');
  }

  const result = await serviceJwtVerifier.verify(jwt, { lxm: nsid as any });
  if (!result.ok) {
    authRequiredWith(result.error.description);
    throw new Error('unreachable');
  }

  return { did: result.value.issuer };
};

const serializeBodyForForwarding = (body: unknown): string | undefined => {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === 'string') {
    return body;
  }

  return JSON.stringify(body);
};

const prepareXrpcRequest = async (request: Request, parsedBody: unknown): Promise<Request> => {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return request;
  }

  const headers = new Headers(request.headers);
  headers.delete('content-length');

  let bodyText: string | undefined;

  if (!request.bodyUsed) {
    try {
      bodyText = await request.text();
    } catch {
      bodyText = undefined;
    }
  }

  if (bodyText === undefined) {
    bodyText = serializeBodyForForwarding(parsedBody);
    if (bodyText !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }

  return new Request(request.url, {
    method: request.method,
    headers,
    body: bodyText,
  });
};

const normalizeNsidPath = (request: Request): { request: Request; rawNsid: string; nsid: string } => {
  const url = new URL(request.url);
  const rawNsidFull = url.pathname.startsWith('/xrpc/') ? url.pathname.slice('/xrpc/'.length) : url.pathname;
  const rawNsid = rawNsidFull.replace(/^\/+|\/+$/g, '');
  const nsid = NSID_ALIASES[rawNsid] ?? rawNsid;

  if (nsid === rawNsid) {
    return { request, rawNsid, nsid };
  }

  url.pathname = `/xrpc/${nsid}`;

  return {
    request: new Request(url.toString(), request),
    rawNsid,
    nsid,
  };
};

const withNsid = <T extends { nsid: string }>(schema: T, nsid: string): T => {
  if (schema.nsid === nsid) {
    return schema;
  }

  return { ...schema, nsid } as T;
};

const addQueryWithAliases = (
  router: XRPCRouter,
  schema: { nsid: string },
  aliases: readonly string[],
  config: { handler: (ctx: any) => Promise<Response> | Response },
) => {
  const seen = new Set<string>();
  for (const nsid of [schema.nsid, ...aliases]) {
    if (seen.has(nsid)) {
      continue;
    }
    seen.add(nsid);
    router.addQuery(withNsid(schema as any, nsid), config as any);
  }
};

const addProcedureWithAliases = (
  router: XRPCRouter,
  schema: { nsid: string },
  aliases: readonly string[],
  config: { handler: (ctx: any) => Promise<Response> | Response },
) => {
  const seen = new Set<string>();
  for (const nsid of [schema.nsid, ...aliases]) {
    if (seen.has(nsid)) {
      continue;
    }
    seen.add(nsid);
    router.addProcedure(withNsid(schema as any, nsid), config as any);
  }
};

const claimWispSubdomain = async (
  did: DidString,
  input: { handle: string; siteRkey?: string },
) => {
  const handle = input.handle.trim().toLowerCase();
  if (!isValidHandle(handle)) {
    invalidDomain('invalid wisp subdomain handle');
  }

  const domain = toDomain(handle);
  const existing = await isDomainRegistered(domain);
  if (existing.registered && existing.did !== did) {
    alreadyClaimed('domain is already claimed');
  }

  if (existing.registered && existing.did === did) {
    if (input.siteRkey !== undefined) {
      await updateWispDomainSite(domain, input.siteRkey);
    }

    return json({
      domain,
      kind: 'wisp',
      status: 'verified',
      siteRkey: input.siteRkey ?? existing.rkey ?? undefined,
    });
  }

  try {
    await claimDomain(did, handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';

    if (message === 'domain_limit_reached') {
      domainLimitReached();
    }
    if (message === 'invalid_handle') {
      invalidDomain('invalid wisp subdomain handle');
    }

    alreadyClaimed('domain is already claimed');
  }

  if (input.siteRkey !== undefined) {
    await updateWispDomainSite(domain, input.siteRkey);
  }

  return json({
    domain,
    kind: 'wisp',
    status: 'verified',
    siteRkey: input.siteRkey,
  });
};

const claimCustomDomainForDid = async (
  did: DidString,
  input: { domain: string; siteRkey?: string },
) => {
  const domain = normalizeDomain(input.domain);
  if (domain.length === 0) {
    invalidDomain('domain is required');
  }

  if (extractWispHandle(domain) !== null) {
    invalidDomain('wisp subdomains must be claimed via place.wisp.v2.domain.claimSubdomain');
  }

  const customError = validateCustomDomain(domain);
  if (customError !== null) {
    invalidDomain(customError);
  }

  const existing = await getCustomDomainInfo(domain);
  if (existing && existing.verified && existing.did !== did) {
    alreadyClaimed('domain is already claimed');
  }

  if (existing && existing.did === did) {
    if (input.siteRkey !== undefined) {
      await updateCustomDomainRkey(existing.id, input.siteRkey);
    }

    const status = existing.verified ? 'verified' : 'pendingVerification';

    return json({
      domain,
      kind: 'custom',
      status,
      siteRkey: input.siteRkey ?? existing.rkey ?? undefined,
      ...buildCustomDnsInstructions(domain, did, existing.id),
    });
  }

  const challengeId = createHash('sha256').update(`${did}:${domain}`).digest('hex').substring(0, 16);

  try {
    await claimCustomDomain(did, domain, challengeId, input.siteRkey ?? null);
  } catch {
    alreadyClaimed('domain is already claimed');
  }

  return json({
    domain,
    kind: 'custom',
    status: 'pendingVerification',
    siteRkey: input.siteRkey,
    ...buildCustomDnsInstructions(domain, did, challengeId),
  });
};

const mapDomainToSiteForDid = async (
  did: DidString,
  input: { domain: string; siteRkey: string },
) => {
  const domain = normalizeDomain(input.domain);
  if (domain.length === 0) {
    invalidDomain('domain is required');
  }

  const siteRkey = input.siteRkey.trim();
  if (siteRkey.length === 0) {
    invalidRequest('siteRkey is required');
  }

  const sites = await getSitesByDid(did);
  const ownsSite = sites.some((entry: { rkey: string }) => entry.rkey === siteRkey);
  if (!ownsSite) {
    notFound('site not found');
  }

  const existing = await isDomainRegistered(domain);
  if (!existing.registered || existing.did !== did) {
    notFound('domain not found');
  }

  if (existing.type === 'wisp') {
    await updateWispDomainSite(domain, siteRkey);

    return json({
      domain,
      kind: 'wisp',
      status: 'verified',
      siteRkey,
      mapped: true,
    });
  }

  const custom = await getCustomDomainInfo(domain);
  if (!custom || custom.did !== did) {
    notFound('domain not found');
  }

  await updateCustomDomainRkey(custom.id as string, siteRkey);

  return json({
    domain,
    kind: 'custom',
    status: custom.verified ? 'verified' : 'pendingVerification',
    siteRkey,
    mapped: true,
  });
};

const deleteSiteForDid = async (
  did: DidString,
  input: { siteRkey: string },
) => {
  const siteRkey = input.siteRkey.trim();
  if (siteRkey.length === 0) {
    invalidRequest('siteRkey is required');
  }

  const sites = await getSitesByDid(did);
  const ownsSite = sites.some((entry: { rkey: string }) => entry.rkey === siteRkey);
  if (!ownsSite) {
    notFound('site not found');
  }

  const mappedDomains = await getDomainsBySite(did, siteRkey);

  const unmappedDomains: Array<{
    domain: string;
    kind: 'wisp' | 'custom';
    status: 'pendingVerification' | 'verified';
  }> = [];

  for (const mapped of mappedDomains as Array<{
    type: 'wisp' | 'custom';
    domain: string;
    id?: string;
    verified?: boolean;
  }>) {
    if (mapped.type === 'wisp') {
      await updateWispDomainSite(mapped.domain, null);
      unmappedDomains.push({
        domain: mapped.domain,
        kind: 'wisp',
        status: 'verified',
      });
      continue;
    }

    if (mapped.id) {
      await updateCustomDomainRkey(mapped.id, null);
      unmappedDomains.push({
        domain: mapped.domain,
        kind: 'custom',
        status: mapped.verified ? 'verified' : 'pendingVerification',
      });
    }
  }

  const deleted = await deleteSite(did, siteRkey);
  if (!deleted.success) {
    throw new XRPCError({
      status: 500,
      error: 'InternalServerError',
      description: 'failed to delete site',
    });
  }

  return json({
    siteRkey,
    deleted: true,
    unmappedDomains: unmappedDomains.sort((a, b) => a.domain.localeCompare(b.domain)),
  });
};

export const xrpcRoutes = () => {
  const authByRequest = new WeakMap<Request, XrpcAuthContext>();
  const router = new XRPCRouter();
  const registeredNsids = [
    XRPC_NSIDS.addSite,
    XRPC_NSIDS.getStatus,
    XRPC_NSIDS.getList,
    XRPC_NSIDS.siteGetList,
    XRPC_NSIDS.claimSubdomain,
    XRPC_NSIDS.claim,
    XRPC_NSIDS.delete,
    XRPC_NSIDS.deleteSite,
  ];

  addProcedureWithAliases(
    router,
    withNsid(PlaceWispV2DomainAddSite.mainSchema as any, XRPC_NSIDS.addSite),
    ['place.wisp.v2.domain.addsite', 'place.wisp.v2.domain.add-site'],
    {
    async handler({ input, request }) {
      const auth = requireAuthenticated(authByRequest.get(request));
      const did = auth.did as DidString;

      return mapDomainToSiteForDid(did, {
        domain: input.domain,
        siteRkey: input.siteRkey,
      });
    },
    },
  );

  addQueryWithAliases(
    router,
    withNsid(PlaceWispV2DomainGetStatus.mainSchema as any, XRPC_NSIDS.getStatus),
    ['place.wisp.v2.domain.getstatus', 'place.wisp.v2.domain.get-status'],
    {
    async handler({ params, request }) {
      const domain = normalizeDomain(params.domain);
      const auth = authByRequest.get(request);

      if (domain.length === 0) {
        invalidDomain('domain parameter is required');
      }

      const info = await isDomainRegistered(domain);
      if (!info.registered) {
        return json({
          domain,
          status: 'unclaimed',
        });
      }

      const kind = info.type;
      const ownedByCaller = auth ? auth.did === info.did : undefined;

      if (
        auth &&
        ownedByCaller === false &&
        (kind === 'wisp' || (kind === 'custom' && Boolean(info.verified)))
      ) {
        return json({
          domain,
          kind,
          status: 'alreadyClaimed',
          verified: kind === 'custom' ? Boolean(info.verified) : true,
          siteRkey: info.rkey ?? undefined,
        });
      }

      if (kind === 'custom') {
        const custom = await getCustomDomainInfo(domain);
        const verified = Boolean(custom?.verified);

        return json({
          domain,
          kind,
          status: verified ? 'verified' : 'pendingVerification',
          verified,
          siteRkey: info.rkey ?? undefined,
          lastCheckedAt: toIsoFromEpoch(custom?.last_verified_at),
        });
      }

      return json({
        domain,
        kind,
        status: 'verified',
        verified: true,
        siteRkey: info.rkey ?? undefined,
      });
    },
    },
  );

  addQueryWithAliases(
    router,
    withNsid(PlaceWispV2DomainGetList.mainSchema as any, XRPC_NSIDS.getList),
    ['place.wisp.v2.domain.getlist', 'place.wisp.v2.domain.get-list'],
    {
    async handler({ request }) {
      const auth = requireAuthenticated(authByRequest.get(request));
      const did = auth.did as DidString;

      const [wispDomains, customDomains] = await Promise.all([
        getAllWispDomains(did),
        getCustomDomainsByDid(did),
      ]);

      const domains = [
        ...wispDomains.map((entry: { domain: string; rkey: string | null }) => ({
          domain: entry.domain as string,
          kind: 'wisp' as const,
          status: 'verified' as const,
          verified: true,
          siteRkey: entry.rkey ?? undefined,
        })),
        ...customDomains.map((entry: {
          domain: string;
          verified: boolean;
          rkey: string | null;
          last_verified_at?: number | string | null;
        }) => ({
          domain: entry.domain as string,
          kind: 'custom' as const,
          status: entry.verified ? 'verified' as const : 'pendingVerification' as const,
          verified: Boolean(entry.verified),
          siteRkey: entry.rkey ?? undefined,
          lastCheckedAt: toIsoFromEpoch(entry.last_verified_at),
        })),
      ].sort((a, b) => a.domain.localeCompare(b.domain));

      return json({ domains });
    },
    },
  );

  addQueryWithAliases(
    router,
    withNsid(PlaceWispV2SiteGetList.mainSchema as any, XRPC_NSIDS.siteGetList),
    ['place.wisp.v2.site.getlist', 'place.wisp.v2.site.get-list'],
    {
    async handler({ request }) {
      const auth = requireAuthenticated(authByRequest.get(request));
      const did = auth.did as DidString;

      const sites = await getSitesByDid(did);

      const siteSummaries = await Promise.all(
        sites.map(async (site: {
          rkey: string;
          display_name?: string | null;
          created_at?: number | string | null;
          updated_at?: number | string | null;
        }) => {
          const mappedDomains = await getDomainsBySite(did, site.rkey);
          const domains = (mappedDomains as Array<{
            type: 'wisp' | 'custom';
            domain: string;
            verified?: boolean;
          }>)
            .map((entry) => ({
              domain: entry.domain,
              kind: entry.type,
              status:
                entry.type === 'wisp'
                  ? ('verified' as const)
                  : entry.verified
                    ? ('verified' as const)
                    : ('pendingVerification' as const),
              verified: entry.type === 'wisp' ? true : Boolean(entry.verified),
            }))
            .sort((a, b) => a.domain.localeCompare(b.domain));

          return {
            siteRkey: site.rkey,
            displayName: site.display_name ?? undefined,
            createdAt: toIsoFromEpoch(site.created_at),
            updatedAt: toIsoFromEpoch(site.updated_at),
            domains,
          };
        }),
      );

      return json({ sites: siteSummaries });
    },
    },
  );

  addProcedureWithAliases(
    router,
    withNsid(PlaceWispV2DomainClaimSubdomain.mainSchema as any, XRPC_NSIDS.claimSubdomain),
    ['place.wisp.v2.domain.claimsubdomain', 'place.wisp.v2.domain.claim-subdomain'],
    {
    async handler({ input, request }) {
      const auth = requireAuthenticated(authByRequest.get(request));
      const did = auth.did as DidString;

      return claimWispSubdomain(did, {
        handle: input.handle,
        siteRkey: input.siteRkey,
      });
    },
    },
  );

  addProcedureWithAliases(
    router,
    withNsid(PlaceWispV2DomainClaim.mainSchema as any, XRPC_NSIDS.claim),
    [],
    {
    async handler({ input, request }) {
      const auth = requireAuthenticated(authByRequest.get(request));
      const did = auth.did as DidString;

      return claimCustomDomainForDid(did, {
        domain: input.domain,
        siteRkey: input.siteRkey,
      });
    },
    },
  );

  addProcedureWithAliases(
    router,
    withNsid(PlaceWispV2DomainDelete.mainSchema as any, XRPC_NSIDS.delete),
    [],
    {
    async handler({ params, request }) {
      const auth = requireAuthenticated(authByRequest.get(request));
      const did = auth.did as DidString;

      const domain = normalizeDomain(params.domain);
      if (domain.length === 0) {
        invalidDomain('domain is required');
      }

      const existing = await isDomainRegistered(domain);
      if (!existing.registered) {
        notFound();
      }

      if (existing.did !== did) {
        notFound();
      }

      if (existing.type === 'wisp') {
        await deleteWispDomain(domain);
      } else {
        const custom = await getCustomDomainInfo(domain);
        if (!custom || custom.did !== did) {
          notFound();
        }

        await deleteCustomDomain(custom.id as string);
      }

      return json({
        domain,
        deleted: true,
      });
    },
    },
  );

  addProcedureWithAliases(
    router,
    withNsid(PlaceWispV2SiteDelete.mainSchema as any, XRPC_NSIDS.deleteSite),
    ['place.wisp.v2.site.deletesite', 'place.wisp.v2.site.delete-site'],
    {
    async handler({ input, request }) {
      const auth = requireAuthenticated(authByRequest.get(request));
      const did = auth.did as DidString;

      return deleteSiteForDid(did, {
        siteRkey: input.siteRkey,
      });
    },
    },
  );

  const schemaNsids = {
    addSite: (PlaceWispV2DomainAddSite.mainSchema as any).nsid,
    getStatus: (PlaceWispV2DomainGetStatus.mainSchema as any).nsid,
    getList: (PlaceWispV2DomainGetList.mainSchema as any).nsid,
    siteGetList: (PlaceWispV2SiteGetList.mainSchema as any).nsid,
    claimSubdomain: (PlaceWispV2DomainClaimSubdomain.mainSchema as any).nsid,
    claim: (PlaceWispV2DomainClaim.mainSchema as any).nsid,
    delete: (PlaceWispV2DomainDelete.mainSchema as any).nsid,
    deleteSite: (PlaceWispV2SiteDelete.mainSchema as any).nsid,
  };
  logger.info('[XRPC] Registered methods', {
    expectedNsids: registeredNsids,
    schemaNsids,
  });
  if (isLocalDev) {
    console.log('[XRPC] Registered methods', {
      expectedNsids: registeredNsids,
      schemaNsids,
    });
  }

  const handleXrpcRequest = async (request: Request, body: unknown): Promise<Response> => {
    const startedAt = Date.now();
    let xrpcRequest: Request | undefined;
    let nsid = '';
    let rawNsid = '';
    let auth: XrpcAuthContext | undefined;

    try {
      const preparedRequest = await prepareXrpcRequest(request, body);
      const normalized = normalizeNsidPath(preparedRequest);
      xrpcRequest = normalized.request;
      rawNsid = normalized.rawNsid;
      nsid = normalized.nsid;

      const authorization = xrpcRequest.headers.get('authorization');
      const origin = xrpcRequest.headers.get('origin') ?? '-';
      const authScheme = authorization ? authorization.split(' ')[0] : '-';
      logger.info('[XRPC] Incoming', {
        method: xrpcRequest.method,
        rawNsid,
        nsid,
        origin,
        hasAuth: Boolean(authorization),
        scheme: authScheme,
      });
      if (isLocalDev) {
        console.log('[XRPC] Incoming', {
          method: xrpcRequest.method,
          rawNsid,
          nsid,
          origin,
          hasAuth: Boolean(authorization),
          scheme: authScheme,
        });
      }

      auth = await resolveServiceAuth(xrpcRequest, nsid);
      if (auth) {
        authByRequest.set(xrpcRequest, auth);
      }

      const response = await router.fetch(xrpcRequest);

      if (!response.ok) {
        let responseData: unknown;
        try {
          responseData = await response.clone().json();
        } catch {
          responseData = await response.clone().text();
        }

        logger.warn('[XRPC] Failed', {
          method: xrpcRequest.method,
          rawNsid,
          nsid,
          status: response.status,
          did: auth?.did ?? '-',
          durationMs: Date.now() - startedAt,
          origin: xrpcRequest.headers.get('origin') ?? undefined,
          requestBodyUsed: request.bodyUsed,
          error: responseData,
        });
      } else {
        logger.info('[XRPC] Succeeded', {
          method: xrpcRequest.method,
          rawNsid,
          nsid,
          status: response.status,
          did: auth?.did ?? '-',
          durationMs: Date.now() - startedAt,
        });
      }

      return response;
    } catch (err) {
      logger.error('[XRPC] Handler error', err, {
        method: xrpcRequest?.method ?? request.method,
        rawNsid: rawNsid || '-',
        nsid: nsid || '-',
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        origin: request.headers.get('origin') ?? undefined,
      });
      throw err;
    } finally {
      if (xrpcRequest) {
        authByRequest.delete(xrpcRequest);
      }
    }
  };

  return new Elysia()
    .all('/xrpc/:nsid', ({ body, request }) => handleXrpcRequest(request, body))
    .all('/xrpc/:nsid/', async ({ body, request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/') && url.pathname.length > '/xrpc/'.length) {
        url.pathname = url.pathname.slice(0, -1);
      }

      const rewritten = new Request(url.toString(), request);
      return handleXrpcRequest(rewritten, body);
    });
};
