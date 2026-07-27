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
const id = 'place.wisp.v2.domain.getList'

export type QueryParams = {}
export type InputSchema = undefined

export interface OutputSchema {
  /** Domains owned by the caller DID. */
  domains: DomainSummary[]
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
  error?: 'AuthenticationRequired' | 'InvalidRequest'
}

export type HandlerOutput = HandlerError | HandlerSuccess

/** Summary of a claimed domain for list views. */
export interface DomainSummary {
  $type?: 'place.wisp.v2.domain.getList#domainSummary'
  domain: string
  kind: 'wisp' | 'custom'
  status: 'pendingVerification' | 'verified'
  verified: boolean
  siteRkey?: string
  lastCheckedAt?: string
}

const hashDomainSummary = 'domainSummary'

export function isDomainSummary<V>(v: V) {
  return is$typed(v, id, hashDomainSummary)
}

export function validateDomainSummary<V>(v: V) {
  return validate<DomainSummary & V>(v, id, hashDomainSummary)
}
