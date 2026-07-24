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
const id = 'place.wisp.v2.domain.claim'

export type QueryParams = {}

export interface InputSchema {
  /** Custom domain FQDN to claim (for example, example.com). */
  domain: string
  /** Optional place.wisp.fs rkey to map immediately after claim. */
  siteRkey?: string
}

export interface OutputSchema {
  domain: string
  kind?: 'custom'
  status: 'alreadyClaimed' | 'pendingVerification' | 'verified'
  /** Identifier used to construct DNS challenge targets for custom domains. */
  challengeId?: string
  /** TXT hostname to set for ownership proof (custom domains). */
  txtName?: string
  /** TXT value to set for ownership proof (custom domains). */
  txtValue?: string
  /** Advisory CNAME target (custom domains). */
  cnameTarget?: string
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
