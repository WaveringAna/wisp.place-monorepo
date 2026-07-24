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
const id = 'place.wisp.v2.privateSite.list'

export type QueryParams = {}
export type InputSchema = undefined

export interface OutputSchema {
  sites: PrivateSiteSummary[]
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
  error?: 'AuthenticationRequired'
}

export type HandlerOutput = HandlerError | HandlerSuccess

export interface PrivateSiteSummary {
  $type?: 'place.wisp.v2.privateSite.list#privateSiteSummary'
  siteId: string
  name: string
  fileCount: number
  totalBytes: number
  expiresAt?: string
  createdAt: string
  /** Number of share links that currently grant access. */
  shareCount: number
  expired: boolean
}

const hashPrivateSiteSummary = 'privateSiteSummary'

export function isPrivateSiteSummary<V>(v: V) {
  return is$typed(v, id, hashPrivateSiteSummary)
}

export function validatePrivateSiteSummary<V>(v: V) {
  return validate<PrivateSiteSummary & V>(v, id, hashPrivateSiteSummary)
}
