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
const id = 'place.wisp.v2.domain.claimSubdomain'

export type QueryParams = {}

export interface InputSchema {
  /** Subdomain label only (for example, alice). */
  handle: string
  /** Optional place.wisp.fs rkey to map immediately after claim. */
  siteRkey?: string
}

export interface OutputSchema {
  domain: string
  kind: 'wisp'
  status: 'verified' | 'alreadyClaimed'
  siteRkey?: string
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
  error?:
    | 'AuthenticationRequired'
    | 'InvalidDomain'
    | 'AlreadyClaimed'
    | 'DomainLimitReached'
    | 'RateLimitExceeded'
}

export type HandlerOutput = HandlerError | HandlerSuccess
