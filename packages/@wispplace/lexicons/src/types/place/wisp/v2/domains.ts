/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../../lexicons.js'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../../util.js'

const is$typed = _is$typed,
  validate = _validate
const id = 'place.wisp.v2.domains'

export interface Main {
  $type: 'place.wisp.v2.domains'
  /** Lowercase FQDN for this registration (for example, alice.wisp.place or example.com). */
  domain: string
  registration:
    $Typed<WispRegistration> | $Typed<CustomRegistration> | { $type: string }
  /** Optional place.wisp.fs record key currently mapped to this domain. */
  siteRkey?: string
  createdAt: string
  updatedAt: string
  [k: string]: unknown
}

const hashMain = 'main'

export function isMain<V>(v: V) {
  return is$typed(v, id, hashMain)
}

export function validateMain<V>(v: V) {
  return validate<Main & V>(v, id, hashMain, true)
}

export {
  type Main as Record,
  isMain as isRecord,
  validateMain as validateRecord,
}

/** Registration for a first-party subdomain under the wisp.place base host. */
export interface WispRegistration {
  $type?: 'place.wisp.v2.domains#wispRegistration'
  kind: 'wisp'
  /** Subdomain label only (for example, alice). */
  handle: string
}

const hashWispRegistration = 'wispRegistration'

export function isWispRegistration<V>(v: V) {
  return is$typed(v, id, hashWispRegistration)
}

export function validateWispRegistration<V>(v: V) {
  return validate<WispRegistration & V>(v, id, hashWispRegistration)
}

/** Registration metadata for a custom domain. */
export interface CustomRegistration {
  $type?: 'place.wisp.v2.domains#customRegistration'
  kind: 'custom'
  /** Challenge identifier used to derive DNS setup instructions. */
  challengeId: string
  verification: Verification
}

const hashCustomRegistration = 'customRegistration'

export function isCustomRegistration<V>(v: V) {
  return is$typed(v, id, hashCustomRegistration)
}

export function validateCustomRegistration<V>(v: V) {
  return validate<CustomRegistration & V>(v, id, hashCustomRegistration)
}

/** Latest verification state for a custom domain. */
export interface Verification {
  $type?: 'place.wisp.v2.domains#verification'
  status: 'pending' | 'verified' | 'failed'
  method: 'txt-did-v1'
  lastCheckedAt?: string
  verifiedAt?: string
  lastError?: string
}

const hashVerification = 'verification'

export function isVerification<V>(v: V) {
  return is$typed(v, id, hashVerification)
}

export function validateVerification<V>(v: V) {
  return validate<Verification & V>(v, id, hashVerification)
}
