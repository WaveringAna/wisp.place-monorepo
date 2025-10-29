/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../lexicons'
import { type $Typed, is$typed as _is$typed, type OmitKey } from '../../../util'

const is$typed = _is$typed,
  validate = _validate
const id = 'place.wisp.fs'

export interface Record {
  $type: 'place.wisp.fs'
  site: string
  root: Directory
  fileCount?: number
  createdAt: string
  [k: string]: unknown
}

const hashRecord = 'main'

export function isRecord<V>(v: V) {
  return is$typed(v, id, hashRecord)
}

export function validateRecord<V>(v: V) {
  return validate<Record & V>(v, id, hashRecord, true)
}

export interface File {
  $type?: 'place.wisp.fs#file'
  type: 'file'
  /** Content blob ref */
  blob: BlobRef
  /** Content encoding (e.g., gzip for compressed files) */
  encoding?: 'gzip'
  /** Original MIME type before compression */
  mimeType?: string
  /** True if blob content is base64-encoded (used to bypass PDS content sniffing) */
  base64?: boolean
}

const hashFile = 'file'

export function isFile<V>(v: V) {
  return is$typed(v, id, hashFile)
}

export function validateFile<V>(v: V) {
  return validate<File & V>(v, id, hashFile)
}

export interface Directory {
  $type?: 'place.wisp.fs#directory'
  type: 'directory'
  entries: Entry[]
}

const hashDirectory = 'directory'

export function isDirectory<V>(v: V) {
  return is$typed(v, id, hashDirectory)
}

export function validateDirectory<V>(v: V) {
  return validate<Directory & V>(v, id, hashDirectory)
}

export interface Entry {
  $type?: 'place.wisp.fs#entry'
  name: string
  node: $Typed<File> | $Typed<Directory> | { $type: string }
}

const hashEntry = 'entry'

export function isEntry<V>(v: V) {
  return is$typed(v, id, hashEntry)
}

export function validateEntry<V>(v: V) {
  return validate<Entry & V>(v, id, hashEntry)
}
