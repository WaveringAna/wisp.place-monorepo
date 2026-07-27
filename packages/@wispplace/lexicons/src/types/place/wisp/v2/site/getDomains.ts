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
const id = 'place.wisp.v2.site.getDomains'

export type QueryParams = {
  did: string
  rkey: string
}
export type InputSchema = undefined

export interface OutputSchema {
  domains: SiteDomain[]
}

export type HandlerInput = void

export interface HandlerSuccess {
  encoding: 'application/json'
  body: OutputSchema
  headers?: { [key: string]: string }
}

export interface HandlerError {
  status: number
  message?: string
}

export type HandlerOutput = HandlerError | HandlerSuccess

export interface SiteDomain {
  $type?: 'place.wisp.v2.site.getDomains#siteDomain'
  domain: string
  kind: 'wisp' | 'custom'
  status: 'pendingVerification' | 'verified'
  verified: boolean
}

const hashSiteDomain = 'siteDomain'

export function isSiteDomain<V>(v: V) {
  return is$typed(v, id, hashSiteDomain)
}

export function validateSiteDomain<V>(v: V) {
  return validate<SiteDomain & V>(v, id, hashSiteDomain)
}
