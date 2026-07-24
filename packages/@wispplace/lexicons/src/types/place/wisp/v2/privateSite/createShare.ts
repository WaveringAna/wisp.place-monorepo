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
const id = 'place.wisp.v2.privateSite.createShare'

export type QueryParams = {}

export interface InputSchema {
  siteId: string
  /** Optional human label for this link. */
  label?: string
  /** Minutes until this link expires. Omit for the configured default; 0 for no expiry of its own. */
  expiryMinutes?: number
}

export interface OutputSchema {
  shareId: string
  siteId: string
  /** Full shareable URL including the credential. Treat as a secret; it is not retrievable later. */
  url: string
  expiresAt?: string
  createdAt: string
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
