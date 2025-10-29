/**
 * GENERATED CODE - DO NOT MODIFY
 */
import {
  type LexiconDoc,
  Lexicons,
  ValidationError,
  type ValidationResult,
} from '@atproto/lexicon'
import { type $Typed, is$typed, maybe$typed } from './util.js'

export const schemaDict = {
  PlaceWispFs: {
    lexicon: 1,
    id: 'place.wisp.fs',
    defs: {
      main: {
        type: 'record',
        description: 'Virtual filesystem manifest for a Wisp site',
        record: {
          type: 'object',
          required: ['site', 'root', 'createdAt'],
          properties: {
            site: {
              type: 'string',
            },
            root: {
              type: 'ref',
              ref: 'lex:place.wisp.fs#directory',
            },
            fileCount: {
              type: 'integer',
              minimum: 0,
              maximum: 1000,
            },
            createdAt: {
              type: 'string',
              format: 'datetime',
            },
          },
        },
      },
      file: {
        type: 'object',
        required: ['type', 'blob'],
        properties: {
          type: {
            type: 'string',
            const: 'file',
          },
          blob: {
            type: 'blob',
            accept: ['*/*'],
            maxSize: 1000000,
            description: 'Content blob ref',
          },
          encoding: {
            type: 'string',
            enum: ['gzip'],
            description: 'Content encoding (e.g., gzip for compressed files)',
          },
          mimeType: {
            type: 'string',
            description: 'Original MIME type before compression',
          },
          base64: {
            type: 'boolean',
            description:
              'True if blob content is base64-encoded (used to bypass PDS content sniffing)',
          },
        },
      },
      directory: {
        type: 'object',
        required: ['type', 'entries'],
        properties: {
          type: {
            type: 'string',
            const: 'directory',
          },
          entries: {
            type: 'array',
            maxLength: 500,
            items: {
              type: 'ref',
              ref: 'lex:place.wisp.fs#entry',
            },
          },
        },
      },
      entry: {
        type: 'object',
        required: ['name', 'node'],
        properties: {
          name: {
            type: 'string',
            maxLength: 255,
          },
          node: {
            type: 'union',
            refs: ['lex:place.wisp.fs#file', 'lex:place.wisp.fs#directory'],
          },
        },
      },
    },
  },
} as const satisfies Record<string, LexiconDoc>
export const schemas = Object.values(schemaDict) satisfies LexiconDoc[]
export const lexicons: Lexicons = new Lexicons(schemas)

export function validate<T extends { $type: string }>(
  v: unknown,
  id: string,
  hash: string,
  requiredType: true,
): ValidationResult<T>
export function validate<T extends { $type?: string }>(
  v: unknown,
  id: string,
  hash: string,
  requiredType?: false,
): ValidationResult<T>
export function validate(
  v: unknown,
  id: string,
  hash: string,
  requiredType?: boolean,
): ValidationResult {
  return (requiredType ? is$typed : maybe$typed)(v, id, hash)
    ? lexicons.validate(`${id}#${hash}`, v)
    : {
        success: false,
        error: new ValidationError(
          `Must be an object with "${hash === 'main' ? id : `${id}#${hash}`}" $type property`,
        ),
      }
}

export const ids = {
  PlaceWispFs: 'place.wisp.fs',
} as const
