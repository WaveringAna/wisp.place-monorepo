/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../../lexicons.js'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../../util.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'place.wisp.v2.wh'

export interface Main {
  $type: 'place.wisp.v2.wh'
  scope: AtUri
  /** HTTPS endpoint to POST the webhook payload to. */
  url: string
  /** Which record events to trigger on. Defaults to all events if omitted. */
  events?: ('create' | 'update' | 'delete')[]
  /** Optional raw secret used to sign the webhook payload with HMAC-SHA256. Prefer secretId to avoid embedding plaintext values in PDS records. */
  secret?: string
  /** Name of a server-managed signing secret created via place.wisp.v2.secret.create. Takes precedence over secret if both are present. */
  secretId?: string
  /** Whether the webhook is active. Defaults to true if omitted. */
  enabled?: boolean
  /** Timestamp of when the webhook was created. */
  createdAt: string
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

/** Watch by AT-URI. at://did watches all collections for a DID. at://did/collection watches all records of that collection for a DID. at://did/collection/record watches a specific record. */
export interface AtUri {
  $type?: 'place.wisp.v2.wh#atUri'
  aturi: string
  /** If true, also watch for records in any repo that reference this DID and collection. */
  backlinks?: boolean
}

const hashAtUri = 'atUri'

export function isAtUri<V>(v: V) {
  return is$typed(v, id, hashAtUri)
}

export function validateAtUri<V>(v: V) {
  return validate<AtUri & V>(v, id, hashAtUri)
}
