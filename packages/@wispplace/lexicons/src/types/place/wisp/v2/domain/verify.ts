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
const id = 'place.wisp.v2.domain.verify'

export type QueryParams = {}

export interface InputSchema {
  /** Custom domain FQDN to verify (for example, example.com). */
  domain: string
}

export interface OutputSchema {
  domain: string
  kind: 'custom'
  status: 'pendingVerification' | 'verified'
  verified: boolean
  /** Human-readable reason verification did not pass (when not verified). */
  error?: string
  /** Non-fatal advisory (for example, CNAME could not be confirmed due to flattening). */
  warning?: string
  /** The TXT value observed during verification, if any. */
  txtFound?: string
  /** The CNAME target observed during verification, if any. */
  cnameFound?: string
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
  error?: 'AuthenticationRequired' | 'InvalidDomain' | 'NotFound'
}

export type HandlerOutput = HandlerError | HandlerSuccess
