/**
 * GENERATED CODE - DO NOT MODIFY
 */
import stream from 'node:stream'
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
const id = 'place.wisp.v2.privateSite.create'

export type QueryParams = {}
export type InputSchema = string | Uint8Array | Blob

export interface OutputSchema {
  /** Stable identifier for this private site. Record-key syntax so it can become a permissioned-space key in v2. */
  siteId: string
  /** Display name. Not an identifier. */
  name: string
  fileCount: number
  totalBytes: number
  /** Absent when the site never expires. */
  expiresAt?: string
  createdAt: string
  /** Owner-facing URL. Requires an authenticated session. */
  url: string
}

export interface HandlerInput {
  encoding: 'multipart/form-data'
  body: stream.Readable
}

export interface HandlerSuccess {
  encoding: 'application/json'
  body: OutputSchema
  headers?: { [key: string]: string }
}

export interface HandlerError {
  status: number
  message?: string
  error?: 'AuthenticationRequired' | 'InvalidRequest' | 'PayloadTooLarge'
}

export type HandlerOutput = HandlerError | HandlerSuccess
