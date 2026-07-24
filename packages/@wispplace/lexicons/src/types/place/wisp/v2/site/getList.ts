/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../../../lexicons.js'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../../../util.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'place.wisp.v2.site.getList'

export type QueryParams = {}
export type InputSchema = undefined

export interface OutputSchema {
  sites: SiteSummary[]
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
  error?: 'AuthenticationRequired'
}

export type HandlerOutput = HandlerError | HandlerSuccess

export interface SiteSummary {
  $type?: 'place.wisp.v2.site.getList#siteSummary'
  siteRkey: string
  displayName?: string
  createdAt?: string
  updatedAt?: string
  domains: SiteDomain[]
}

const hashSiteSummary = 'siteSummary'

export function isSiteSummary<V>(v: V) {
  return is$typed(v, id, hashSiteSummary)
}

export function validateSiteSummary<V>(v: V) {
  return validate<SiteSummary & V>(v, id, hashSiteSummary)
}

export interface SiteDomain {
  $type?: 'place.wisp.v2.site.getList#siteDomain'
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
