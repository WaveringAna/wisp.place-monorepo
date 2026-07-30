/**
 * GENERATED CODE - DO NOT MODIFY
 */
import {
  type Auth,
  type Options as XrpcOptions,
  Server as XrpcServer,
  type StreamConfigOrHandler,
  type MethodConfigOrHandler,
  createServer as createXrpcServer,
} from '@atproto/xrpc-server'
import { schemas } from './lexicons.js'
import * as PlaceWispV2DomainAddSite from './types/place/wisp/v2/domain/addSite.js'
import * as PlaceWispV2DomainClaimSubdomain from './types/place/wisp/v2/domain/claimSubdomain.js'
import * as PlaceWispV2DomainClaim from './types/place/wisp/v2/domain/claim.js'
import * as PlaceWispV2DomainDelete from './types/place/wisp/v2/domain/delete.js'
import * as PlaceWispV2DomainGetList from './types/place/wisp/v2/domain/getList.js'
import * as PlaceWispV2DomainGetStatus from './types/place/wisp/v2/domain/getStatus.js'
import * as PlaceWispV2DomainVerify from './types/place/wisp/v2/domain/verify.js'
import * as PlaceWispV2PrivateSiteCreateShare from './types/place/wisp/v2/privateSite/createShare.js'
import * as PlaceWispV2PrivateSiteCreate from './types/place/wisp/v2/privateSite/create.js'
import * as PlaceWispV2PrivateSiteDelete from './types/place/wisp/v2/privateSite/delete.js'
import * as PlaceWispV2PrivateSiteListShares from './types/place/wisp/v2/privateSite/listShares.js'
import * as PlaceWispV2PrivateSiteList from './types/place/wisp/v2/privateSite/list.js'
import * as PlaceWispV2PrivateSiteRevokeShare from './types/place/wisp/v2/privateSite/revokeShare.js'
import * as PlaceWispV2SecretCreate from './types/place/wisp/v2/secret/create.js'
import * as PlaceWispV2SecretDelete from './types/place/wisp/v2/secret/delete.js'
import * as PlaceWispV2SecretList from './types/place/wisp/v2/secret/list.js'
import * as PlaceWispV2SecretRotate from './types/place/wisp/v2/secret/rotate.js'
import * as PlaceWispV2SiteDelete from './types/place/wisp/v2/site/delete.js'
import * as PlaceWispV2SiteGetDomains from './types/place/wisp/v2/site/getDomains.js'
import * as PlaceWispV2SiteGetList from './types/place/wisp/v2/site/getList.js'

export function createServer(options?: XrpcOptions): Server {
  return new Server(options)
}

export class Server {
  xrpc: XrpcServer
  place: PlaceNS

  constructor(options?: XrpcOptions) {
    this.xrpc = createXrpcServer(schemas, options)
    this.place = new PlaceNS(this)
  }
}

export class PlaceNS {
  _server: Server
  wisp: PlaceWispNS

  constructor(server: Server) {
    this._server = server
    this.wisp = new PlaceWispNS(server)
  }
}

export class PlaceWispNS {
  _server: Server
  v2: PlaceWispV2NS

  constructor(server: Server) {
    this._server = server
    this.v2 = new PlaceWispV2NS(server)
  }
}

export class PlaceWispV2NS {
  _server: Server
  domain: PlaceWispV2DomainNS
  privateSite: PlaceWispV2PrivateSiteNS
  secret: PlaceWispV2SecretNS
  site: PlaceWispV2SiteNS

  constructor(server: Server) {
    this._server = server
    this.domain = new PlaceWispV2DomainNS(server)
    this.privateSite = new PlaceWispV2PrivateSiteNS(server)
    this.secret = new PlaceWispV2SecretNS(server)
    this.site = new PlaceWispV2SiteNS(server)
  }
}

export class PlaceWispV2DomainNS {
  _server: Server

  constructor(server: Server) {
    this._server = server
  }

  addSite<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2DomainAddSite.QueryParams,
      PlaceWispV2DomainAddSite.HandlerInput,
      PlaceWispV2DomainAddSite.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.domain.addSite' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  claimSubdomain<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2DomainClaimSubdomain.QueryParams,
      PlaceWispV2DomainClaimSubdomain.HandlerInput,
      PlaceWispV2DomainClaimSubdomain.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.domain.claimSubdomain' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  claim<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2DomainClaim.QueryParams,
      PlaceWispV2DomainClaim.HandlerInput,
      PlaceWispV2DomainClaim.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.domain.claim' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  delete<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2DomainDelete.QueryParams,
      PlaceWispV2DomainDelete.HandlerInput,
      PlaceWispV2DomainDelete.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.domain.delete' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  getList<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2DomainGetList.QueryParams,
      PlaceWispV2DomainGetList.HandlerInput,
      PlaceWispV2DomainGetList.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.domain.getList' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  getStatus<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2DomainGetStatus.QueryParams,
      PlaceWispV2DomainGetStatus.HandlerInput,
      PlaceWispV2DomainGetStatus.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.domain.getStatus' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  verify<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2DomainVerify.QueryParams,
      PlaceWispV2DomainVerify.HandlerInput,
      PlaceWispV2DomainVerify.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.domain.verify' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }
}

export class PlaceWispV2PrivateSiteNS {
  _server: Server

  constructor(server: Server) {
    this._server = server
  }

  createShare<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2PrivateSiteCreateShare.QueryParams,
      PlaceWispV2PrivateSiteCreateShare.HandlerInput,
      PlaceWispV2PrivateSiteCreateShare.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.privateSite.createShare' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  create<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2PrivateSiteCreate.QueryParams,
      PlaceWispV2PrivateSiteCreate.HandlerInput,
      PlaceWispV2PrivateSiteCreate.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.privateSite.create' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  delete<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2PrivateSiteDelete.QueryParams,
      PlaceWispV2PrivateSiteDelete.HandlerInput,
      PlaceWispV2PrivateSiteDelete.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.privateSite.delete' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  listShares<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2PrivateSiteListShares.QueryParams,
      PlaceWispV2PrivateSiteListShares.HandlerInput,
      PlaceWispV2PrivateSiteListShares.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.privateSite.listShares' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  list<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2PrivateSiteList.QueryParams,
      PlaceWispV2PrivateSiteList.HandlerInput,
      PlaceWispV2PrivateSiteList.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.privateSite.list' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  revokeShare<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2PrivateSiteRevokeShare.QueryParams,
      PlaceWispV2PrivateSiteRevokeShare.HandlerInput,
      PlaceWispV2PrivateSiteRevokeShare.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.privateSite.revokeShare' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }
}

export class PlaceWispV2SecretNS {
  _server: Server

  constructor(server: Server) {
    this._server = server
  }

  create<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2SecretCreate.QueryParams,
      PlaceWispV2SecretCreate.HandlerInput,
      PlaceWispV2SecretCreate.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.secret.create' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  delete<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2SecretDelete.QueryParams,
      PlaceWispV2SecretDelete.HandlerInput,
      PlaceWispV2SecretDelete.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.secret.delete' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  list<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2SecretList.QueryParams,
      PlaceWispV2SecretList.HandlerInput,
      PlaceWispV2SecretList.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.secret.list' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  rotate<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2SecretRotate.QueryParams,
      PlaceWispV2SecretRotate.HandlerInput,
      PlaceWispV2SecretRotate.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.secret.rotate' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }
}

export class PlaceWispV2SiteNS {
  _server: Server

  constructor(server: Server) {
    this._server = server
  }

  delete<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2SiteDelete.QueryParams,
      PlaceWispV2SiteDelete.HandlerInput,
      PlaceWispV2SiteDelete.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.site.delete' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  getDomains<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2SiteGetDomains.QueryParams,
      PlaceWispV2SiteGetDomains.HandlerInput,
      PlaceWispV2SiteGetDomains.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.site.getDomains' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }

  getList<A extends Auth = void>(
    cfg: MethodConfigOrHandler<
      A,
      PlaceWispV2SiteGetList.QueryParams,
      PlaceWispV2SiteGetList.HandlerInput,
      PlaceWispV2SiteGetList.HandlerOutput
    >,
  ) {
    const nsid = 'place.wisp.v2.site.getList' // @ts-ignore
    return this._server.xrpc.method(nsid, cfg)
  }
}
