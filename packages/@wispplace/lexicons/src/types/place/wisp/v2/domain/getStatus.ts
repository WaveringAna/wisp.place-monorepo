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
const id = 'place.wisp.v2.domain.getStatus'

export type QueryParams = {
  /** Domain to inspect (FQDN, lowercase preferred). */
  domain: string
}
export type InputSchema = undefined

export interface OutputSchema {
  domain: string
  status: 'unclaimed' | 'pendingVerification' | 'verified' | 'alreadyClaimed'
  kind?: 'wisp' | 'custom'
  verified?: boolean
  lastCheckedAt?: string
  lastError?: string
  siteRkey?: string
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
