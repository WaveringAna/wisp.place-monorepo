/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../../../lexicons'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../../../util'

const is$typed = _is$typed,
  validate = _validate
const id = 'place.wisp.v2.site.delete'

export type QueryParams = {}

export interface InputSchema {
  /** Owned place.wisp.fs record key to delete from wisp metadata. */
  siteRkey: string
}

export interface OutputSchema {
  siteRkey: string
  deleted: true
  /** Domains that were detached from this site before deletion. */
  unmappedDomains: UnmappedDomain[]
}

export interface HandlerInput {
  encoding: 'application/json'
  body: InputSchema
}

export interface HandlerSuccess {
  encoding: 'application/json'
  body: OutputSchema
  headers?: { [key: string]: string }
}

export interface HandlerError {
  status: number
  message?: string
  error?: 'AuthenticationRequired' | 'InvalidRequest' | 'NotFound'
}

export type HandlerOutput = HandlerError | HandlerSuccess

export interface UnmappedDomain {
  $type?: 'place.wisp.v2.site.delete#unmappedDomain'
  domain: string
  kind: 'wisp' | 'custom'
  status: 'pendingVerification' | 'verified'
}

const hashUnmappedDomain = 'unmappedDomain'

export function isUnmappedDomain<V>(v: V) {
  return is$typed(v, id, hashUnmappedDomain)
}

export function validateUnmappedDomain<V>(v: V) {
  return validate<UnmappedDomain & V>(v, id, hashUnmappedDomain)
}
