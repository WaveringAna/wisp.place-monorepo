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
const id = 'place.wisp.v2.privateSite.listShares'

export type QueryParams = {
  siteId: string
}
export type InputSchema = undefined

export interface OutputSchema {
  shares: Share[]
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
  error?: 'AuthenticationRequired' | 'NotFound'
}

export type HandlerOutput = HandlerError | HandlerSuccess

export interface Share {
  $type?: 'place.wisp.v2.privateSite.listShares#share'
  shareId: string
  /** Non-secret leading fragment, for identification only. */
  tokenPrefix: string
  label?: string
  expiresAt?: string
  revokedAt?: string
  createdAt: string
  lastUsedAt?: string
  status: 'active' | 'expired' | 'revoked'
}

const hashShare = 'share'

export function isShare<V>(v: V) {
  return is$typed(v, id, hashShare)
}

export function validateShare<V>(v: V) {
  return validate<Share & V>(v, id, hashShare)
}
