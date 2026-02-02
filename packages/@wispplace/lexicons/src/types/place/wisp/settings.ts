/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../lexicons'
import { type $Typed, is$typed as _is$typed, type OmitKey } from '../../../util'

const is$typed = _is$typed,
  validate = _validate
const id = 'place.wisp.settings'

export interface Main {
  $type: 'place.wisp.settings'
  /** Enable directory listing mode for paths that resolve to directories without an index file. Incompatible with spaMode. */
  directoryListing: boolean
  /** File to serve for all routes (e.g., 'index.html'). When set, enables SPA mode where all non-file requests are routed to this file. Incompatible with directoryListing and custom404. */
  spaMode?: string
  /** Custom 404 error page file path. Incompatible with directoryListing and spaMode. */
  custom404?: string
  /** Ordered list of files to try when serving a directory. Defaults to ['index.html'] if not specified. */
  indexFiles?: string[]
  /** Enable clean URL routing. When enabled, '/about' will attempt to serve '/about.html' or '/about/index.html' automatically. */
  cleanUrls: boolean
  /** Custom HTTP headers to set on responses */
  headers?: CustomHeader[]
  [k: string]: unknown
}

const hashMain = 'main'

export function isMain<V>(v: V) {
  return is$typed(v, id, hashMain)
}

export function validateMain<V>(v: V) {
  return validate<Main & V>(v, id, hashMain, true)
}

export {
  type Main as Record,
  isMain as isRecord,
  validateMain as validateRecord,
}

/** Custom HTTP header configuration */
export interface CustomHeader {
  $type?: 'place.wisp.settings#customHeader'
  /** HTTP header name (e.g., 'Cache-Control', 'X-Frame-Options') */
  name: string
  /** HTTP header value */
  value: string
  /** Optional glob pattern to apply this header to specific paths (e.g., '*.html', '/assets/*'). If not specified, applies to all paths. */
  path?: string
}

const hashCustomHeader = 'customHeader'

export function isCustomHeader<V>(v: V) {
  return is$typed(v, id, hashCustomHeader)
}

export function validateCustomHeader<V>(v: V) {
  return validate<CustomHeader & V>(v, id, hashCustomHeader)
}
