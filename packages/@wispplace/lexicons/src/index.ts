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
import * as PlaceWispV2SiteDelete from './types/place/wisp/v2/site/delete.js'
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
  site: PlaceWispV2SiteNS

  constructor(server: Server) {
    this._server = server
    this.domain = new PlaceWispV2DomainNS(server)
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
