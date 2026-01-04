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

  constructor(server: Server) {
    this._server = server
  }
}
