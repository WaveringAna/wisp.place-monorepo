import { createHash } from 'crypto';

import { Elysia } from 'elysia';

import { CompositeDidDocumentResolver, PlcDidDocumentResolver, WebDidDocumentResolver } from '@atcute/identity-resolver';
import { json, XRPCRouter, XRPCError } from '@atcute/xrpc-server';
import { ServiceJwtVerifier } from '@atcute/xrpc-server/auth';
import { PlaceWispV2DomainClaim, PlaceWispV2DomainGetStatus } from '@wispplace/lexicons/atcute';
import { BASE_HOST } from '@wispplace/constants';

import { createLogger } from '@wispplace/observability';

import {
  claimCustomDomain,
  claimDomain,
  getCustomDomainInfo,
  isDomainRegistered,
  updateCustomDomainRkey,
  updateWispDomainSite,
} from '../lib/db';
import {
  extractWispHandle,
  isValidHandle,
  normalizeDomain,
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
  'place.wisp.v2.domain.getstatus': 'place.wisp.v2.domain.getStatus',
  'place.wisp.v2.domain.get-status': 'place.wisp.v2.domain.getStatus',
};

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
  const rawNsid = url.pathname.startsWith('/xrpc/') ? url.pathname.slice('/xrpc/'.length) : url.pathname;
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

export const xrpcRoutes = () => {
  const authByRequest = new WeakMap<Request, XrpcAuthContext>();
  const router = new XRPCRouter();

  router.addQuery(PlaceWispV2DomainGetStatus.mainSchema, {
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

      if (auth && ownedByCaller === false) {
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
  });

  router.addProcedure(PlaceWispV2DomainClaim.mainSchema, {
    async handler({ input, request }) {
      const auth = requireAuthenticated(authByRequest.get(request));
      const did = auth.did as DidString;

      const domain = normalizeDomain(input.domain);
      if (domain.length === 0) {
        invalidDomain('domain is required');
      }

      const wispHandle = extractWispHandle(domain);
      if (wispHandle !== null) {
        if (!isValidHandle(wispHandle)) {
          invalidDomain('invalid wisp subdomain handle');
        }

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
            status: 'alreadyClaimed',
            siteRkey: input.siteRkey ?? existing.rkey ?? undefined,
          });
        }

        try {
          await claimDomain(did, wispHandle);
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
      }

      const customError = validateCustomDomain(domain);
      if (customError !== null) {
        invalidDomain(customError);
      }

      const existing = await getCustomDomainInfo(domain);
      if (existing && existing.verified && existing.did !== did) {
        alreadyClaimed('domain already verified and owned by another user');
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
      } catch (err) {
        alreadyClaimed('domain already verified and owned by another user');
      }

      return json({
        domain,
        kind: 'custom',
        status: 'pendingVerification',
        siteRkey: input.siteRkey,
        ...buildCustomDnsInstructions(domain, did, challengeId),
      });
    },
  });

  return new Elysia().all('/xrpc/*', async ({ body, request }) => {
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
      logger.info('[XRPC] Incoming request', {
        method: xrpcRequest.method,
        rawNsid,
        nsid,
        origin: xrpcRequest.headers.get('origin') ?? undefined,
        hasAuthorization: Boolean(authorization),
        authorizationScheme: authorization ? authorization.split(' ')[0] : undefined,
      });

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

        logger.warn('[XRPC] Request failed', {
          method: xrpcRequest.method,
          rawNsid,
          nsid,
          status: response.status,
          did: auth?.did,
          origin: xrpcRequest.headers.get('origin') ?? undefined,
          requestBodyUsed: request.bodyUsed,
          error: responseData,
          durationMs: Date.now() - startedAt,
        });
      } else {
        logger.info('[XRPC] Request succeeded', {
          method: xrpcRequest.method,
          rawNsid,
          nsid,
          status: response.status,
          did: auth?.did,
          durationMs: Date.now() - startedAt,
        });
      }

      return response;
    } catch (err) {
      logger.error('[XRPC] Handler error', {
        method: xrpcRequest?.method ?? request.method,
        rawNsid: rawNsid || undefined,
        nsid: nsid || undefined,
        origin: request.headers.get('origin') ?? undefined,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (xrpcRequest) {
        authByRequest.delete(xrpcRequest);
      }
    }
  });
};
