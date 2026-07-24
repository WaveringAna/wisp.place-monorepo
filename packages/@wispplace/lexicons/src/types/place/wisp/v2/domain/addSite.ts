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
const id = 'place.wisp.v2.domain.addSite'

export type QueryParams = {}

export interface InputSchema {
  /** Fully-qualified domain to map. */
  domain: string
  /** Owned place.wisp.fs record key to map this domain to. */
  siteRkey: string
}

export interface OutputSchema {
  domain: string
  kind: 'wisp' | 'custom'
  status: 'pendingVerification' | 'verified'
  siteRkey: string
  mapped: true
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
    'AuthenticationRequired' | 'InvalidDomain' | 'InvalidRequest' | 'NotFound'
}

export type HandlerOutput = HandlerError | HandlerSuccess
