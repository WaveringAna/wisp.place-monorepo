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
const id = 'place.wisp.v2.privateSite.revokeShare'

export type QueryParams = {}

export interface InputSchema {
  siteId: string
  shareId: string
}

export interface OutputSchema {
  shareId: string
  revoked: true
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
