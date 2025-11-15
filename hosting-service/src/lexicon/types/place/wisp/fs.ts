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

export interface Main {
  $type: 'place.wisp.fs'
  site: string
  root: Directory
  fileCount?: number
  createdAt: string
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
  node: $Typed<File> | $Typed<Directory> | $Typed<Subfs> | { $type: string }
}

const hashEntry = 'entry'

export function isEntry<V>(v: V) {
  return is$typed(v, id, hashEntry)
}

export function validateEntry<V>(v: V) {
  return validate<Entry & V>(v, id, hashEntry)
}

export interface Subfs {
  $type?: 'place.wisp.fs#subfs'
  type: 'subfs'
  /** AT-URI pointing to a place.wisp.subfs record containing this subtree. */
  subject: string
  /** If true, the subfs record's root entries are merged (flattened) into the parent directory, replacing the subfs entry. If false (default), the subfs entries are placed in a subdirectory with the subfs entry's name. Flat merging is useful for splitting large directories across multiple records while maintaining a flat structure. */
  flat?: boolean
}

const hashSubfs = 'subfs'

export function isSubfs<V>(v: V) {
  return is$typed(v, id, hashSubfs)
}

export function validateSubfs<V>(v: V) {
  return validate<Subfs & V>(v, id, hashSubfs)
}
