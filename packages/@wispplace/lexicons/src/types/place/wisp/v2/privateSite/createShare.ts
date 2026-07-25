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
  /** Restrict this link to a single account. The recipient must be signed in as this DID; the link alone grants nothing. Omit for a bearer link that anyone holding the URL can open, including people without an atproto account. */
  audienceDid?: string
}

export interface OutputSchema {
  shareId: string
  siteId: string
  /** Short, human-friendly share link (wisp.place/p/<token>). Contains the credential and is returned exactly once. */
  url: string
  expiresAt?: string
  createdAt: string
  /** Set when this link is restricted to a single account. */
  audienceDid?: string
  /** The same credential on the site's own origin. Equivalent to `url`; useful when a link should not route through wisp.place. */
  directUrl?: string
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
