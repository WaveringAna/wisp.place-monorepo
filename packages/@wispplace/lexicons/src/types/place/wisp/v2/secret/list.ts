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
const id = 'place.wisp.v2.secret.list'

export type QueryParams = {}
export type InputSchema = undefined

export interface OutputSchema {
  secrets: SecretMeta[]
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

export interface SecretMeta {
  $type?: 'place.wisp.v2.secret.list#secretMeta'
  name: string
  createdAt: string
  lastRotatedAt?: string
}

const hashSecretMeta = 'secretMeta'

export function isSecretMeta<V>(v: V) {
  return is$typed(v, id, hashSecretMeta)
}

export function validateSecretMeta<V>(v: V) {
  return validate<SecretMeta & V>(v, id, hashSecretMeta)
}
