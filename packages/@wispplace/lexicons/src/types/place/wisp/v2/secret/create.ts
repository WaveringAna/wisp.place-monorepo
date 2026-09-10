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
const id = 'place.wisp.v2.secret.create'

export type QueryParams = {}

export interface InputSchema {
  /** Unique 1–64 character secret ID scoped to the caller DID. Use ASCII letters, digits, dots, underscores, and hyphens only. */
  name: string
  /** Optional caller-supplied signing token: 32–256 printable ASCII characters, no whitespace. Omit it to have the server generate one. Use this to register a secret the receiving system already generated. */
  token?: string
}

export interface OutputSchema {
  name: string
  /** The signing token. Only returned at creation time — store it now. */
  token: string
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
  error?: 'AuthenticationRequired' | 'InvalidRequest' | 'AlreadyExists'
}

export type HandlerOutput = HandlerError | HandlerSuccess
