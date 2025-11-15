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
            maxSize: 1000000000,
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
            refs: [
              'lex:place.wisp.fs#file',
              'lex:place.wisp.fs#directory',
              'lex:place.wisp.fs#subfs',
            ],
          },
        },
      },
      subfs: {
        type: 'object',
        required: ['type', 'subject'],
        properties: {
          type: {
            type: 'string',
            const: 'subfs',
          },
          subject: {
            type: 'string',
            format: 'at-uri',
            description:
              'AT-URI pointing to a place.wisp.subfs record containing this subtree.',
          },
          flat: {
            type: 'boolean',
            description:
              "If true, the subfs record's root entries are merged (flattened) into the parent directory, replacing the subfs entry. If false (default), the subfs entries are placed in a subdirectory with the subfs entry's name. Flat merging is useful for splitting large directories across multiple records while maintaining a flat structure.",
          },
        },
      },
    },
  },
  PlaceWispSubfs: {
    lexicon: 1,
    id: 'place.wisp.subfs',
    defs: {
      main: {
        type: 'record',
        description:
          'Virtual filesystem subtree referenced by place.wisp.fs records. When a subfs entry is expanded, its root entries are merged (flattened) into the parent directory, allowing large directories to be split across multiple records while maintaining a flat structure.',
        record: {
          type: 'object',
          required: ['root', 'createdAt'],
          properties: {
            root: {
              type: 'ref',
              ref: 'lex:place.wisp.subfs#directory',
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
            maxSize: 1000000000,
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
              ref: 'lex:place.wisp.subfs#entry',
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
            refs: [
              'lex:place.wisp.subfs#file',
              'lex:place.wisp.subfs#directory',
              'lex:place.wisp.subfs#subfs',
            ],
          },
        },
      },
      subfs: {
        type: 'object',
        required: ['type', 'subject'],
        properties: {
          type: {
            type: 'string',
            const: 'subfs',
          },
          subject: {
            type: 'string',
            format: 'at-uri',
            description:
              "AT-URI pointing to another place.wisp.subfs record for nested subtrees. When expanded, the referenced record's root entries are merged (flattened) into the parent directory, allowing recursive splitting of large directory structures.",
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
  PlaceWispSubfs: 'place.wisp.subfs',
} as const
