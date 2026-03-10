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
  PlaceWispV2DomainAddSite: {
    lexicon: 1,
    id: 'place.wisp.v2.domain.addSite',
    defs: {
      main: {
        type: 'procedure',
        description: 'Map an owned domain to one owned site record.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['domain', 'siteRkey'],
            properties: {
              domain: {
                type: 'string',
                description: 'Fully-qualified domain to map.',
                minLength: 3,
                maxLength: 253,
              },
              siteRkey: {
                type: 'string',
                format: 'record-key',
                description:
                  'Owned place.wisp.fs record key to map this domain to.',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['domain', 'kind', 'status', 'siteRkey', 'mapped'],
            properties: {
              domain: {
                type: 'string',
              },
              kind: {
                type: 'string',
                enum: ['wisp', 'custom'],
              },
              status: {
                type: 'string',
                enum: ['pendingVerification', 'verified'],
              },
              siteRkey: {
                type: 'string',
                format: 'record-key',
              },
              mapped: {
                type: 'boolean',
                const: true,
              },
            },
          },
        },
        errors: [
          {
            name: 'AuthenticationRequired',
          },
          {
            name: 'InvalidDomain',
          },
          {
            name: 'InvalidRequest',
          },
          {
            name: 'NotFound',
          },
        ],
      },
    },
  },
  PlaceWispV2DomainClaimSubdomain: {
    lexicon: 1,
    id: 'place.wisp.v2.domain.claimSubdomain',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Claim a wisp.place subdomain handle for the authenticated DID.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['handle'],
            properties: {
              handle: {
                type: 'string',
                description: 'Subdomain label only (for example, alice).',
                minLength: 3,
                maxLength: 63,
              },
              siteRkey: {
                type: 'string',
                format: 'record-key',
                description:
                  'Optional place.wisp.fs rkey to map immediately after claim.',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['domain', 'kind', 'status'],
            properties: {
              domain: {
                type: 'string',
              },
              kind: {
                type: 'string',
                enum: ['wisp'],
              },
              status: {
                type: 'string',
                enum: ['verified', 'alreadyClaimed'],
              },
              siteRkey: {
                type: 'string',
                format: 'record-key',
              },
            },
          },
        },
        errors: [
          {
            name: 'AuthenticationRequired',
          },
          {
            name: 'InvalidDomain',
          },
          {
            name: 'AlreadyClaimed',
          },
          {
            name: 'DomainLimitReached',
          },
          {
            name: 'RateLimitExceeded',
          },
        ],
      },
    },
  },
  PlaceWispV2DomainClaim: {
    lexicon: 1,
    id: 'place.wisp.v2.domain.claim',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Claim a custom domain for the authenticated DID. Returns DNS setup instructions.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['domain'],
            properties: {
              domain: {
                type: 'string',
                description:
                  'Custom domain FQDN to claim (for example, example.com).',
                minLength: 3,
                maxLength: 253,
              },
              siteRkey: {
                type: 'string',
                format: 'record-key',
                description:
                  'Optional place.wisp.fs rkey to map immediately after claim.',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['domain', 'status'],
            properties: {
              domain: {
                type: 'string',
              },
              kind: {
                type: 'string',
                enum: ['custom'],
              },
              status: {
                type: 'string',
                enum: ['alreadyClaimed', 'pendingVerification', 'verified'],
              },
              challengeId: {
                type: 'string',
                description:
                  'Identifier used to construct DNS challenge targets for custom domains.',
                minLength: 8,
                maxLength: 64,
              },
              txtName: {
                type: 'string',
                description:
                  'TXT hostname to set for ownership proof (custom domains).',
                minLength: 3,
                maxLength: 253,
              },
              txtValue: {
                type: 'string',
                format: 'did',
                description:
                  'TXT value to set for ownership proof (custom domains).',
              },
              cnameTarget: {
                type: 'string',
                description: 'Advisory CNAME target (custom domains).',
                minLength: 3,
                maxLength: 253,
              },
              siteRkey: {
                type: 'string',
                format: 'record-key',
              },
            },
          },
        },
        errors: [
          {
            name: 'AuthenticationRequired',
          },
          {
            name: 'InvalidDomain',
          },
          {
            name: 'AlreadyClaimed',
          },
          {
            name: 'DomainLimitReached',
          },
          {
            name: 'RateLimitExceeded',
          },
        ],
      },
    },
  },
  PlaceWispV2DomainDelete: {
    lexicon: 1,
    id: 'place.wisp.v2.domain.delete',
    defs: {
      main: {
        type: 'procedure',
        description: 'Delete a claimed domain owned by the authenticated DID.',
        parameters: {
          type: 'params',
          required: ['domain'],
          properties: {
            domain: {
              type: 'string',
              description:
                'Fully-qualified domain to delete (wisp subdomain or custom domain).',
              minLength: 3,
              maxLength: 253,
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['domain', 'deleted'],
            properties: {
              domain: {
                type: 'string',
              },
              deleted: {
                type: 'boolean',
                const: true,
              },
            },
          },
        },
        errors: [
          {
            name: 'AuthenticationRequired',
          },
          {
            name: 'InvalidDomain',
          },
          {
            name: 'NotFound',
          },
        ],
      },
    },
  },
  PlaceWispV2DomainGetList: {
    lexicon: 1,
    id: 'place.wisp.v2.domain.getList',
    defs: {
      main: {
        type: 'query',
        description:
          'List domains for the authenticated DID (wisp subdomains + custom).',
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['domains'],
            properties: {
              domains: {
                type: 'array',
                description: 'Domains owned by the caller DID.',
                items: {
                  type: 'ref',
                  ref: 'lex:place.wisp.v2.domain.getList#domainSummary',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'AuthenticationRequired',
          },
          {
            name: 'InvalidRequest',
          },
        ],
      },
      domainSummary: {
        type: 'object',
        description: 'Summary of a claimed domain for list views.',
        required: ['domain', 'kind', 'status', 'verified'],
        properties: {
          domain: {
            type: 'string',
            minLength: 3,
            maxLength: 253,
          },
          kind: {
            type: 'string',
            enum: ['wisp', 'custom'],
          },
          status: {
            type: 'string',
            enum: ['pendingVerification', 'verified'],
          },
          verified: {
            type: 'boolean',
          },
          siteRkey: {
            type: 'string',
            format: 'record-key',
          },
          lastCheckedAt: {
            type: 'string',
            format: 'datetime',
          },
        },
      },
    },
  },
  PlaceWispV2DomainGetStatus: {
    lexicon: 1,
    id: 'place.wisp.v2.domain.getStatus',
    defs: {
      main: {
        type: 'query',
        description: 'Get current claim and verification status for a domain.',
        parameters: {
          type: 'params',
          required: ['domain'],
          properties: {
            domain: {
              type: 'string',
              description: 'Domain to inspect (FQDN, lowercase preferred).',
              minLength: 3,
              maxLength: 253,
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['domain', 'status'],
            properties: {
              domain: {
                type: 'string',
              },
              status: {
                type: 'string',
                enum: [
                  'unclaimed',
                  'pendingVerification',
                  'verified',
                  'alreadyClaimed',
                ],
              },
              kind: {
                type: 'string',
                enum: ['wisp', 'custom'],
              },
              verified: {
                type: 'boolean',
              },
              lastCheckedAt: {
                type: 'string',
                format: 'datetime',
              },
              lastError: {
                type: 'string',
                maxLength: 1000,
              },
              siteRkey: {
                type: 'string',
                format: 'record-key',
              },
            },
          },
        },
      },
    },
  },
  PlaceWispV2Domains: {
    lexicon: 1,
    id: 'place.wisp.v2.domains',
    defs: {
      main: {
        type: 'record',
        description:
          'Domain registration metadata for wisp.place subdomains and custom domains.',
        key: 'any',
        record: {
          type: 'object',
          required: ['domain', 'registration', 'createdAt', 'updatedAt'],
          properties: {
            domain: {
              type: 'string',
              description:
                'Lowercase FQDN for this registration (for example, alice.wisp.place or example.com).',
              minLength: 3,
              maxLength: 253,
            },
            registration: {
              type: 'union',
              refs: [
                'lex:place.wisp.v2.domains#wispRegistration',
                'lex:place.wisp.v2.domains#customRegistration',
              ],
            },
            siteRkey: {
              type: 'string',
              format: 'record-key',
              description:
                'Optional place.wisp.fs record key currently mapped to this domain.',
            },
            createdAt: {
              type: 'string',
              format: 'datetime',
            },
            updatedAt: {
              type: 'string',
              format: 'datetime',
            },
          },
        },
      },
      wispRegistration: {
        type: 'object',
        description:
          'Registration for a first-party subdomain under the wisp.place base host.',
        required: ['kind', 'handle'],
        properties: {
          kind: {
            type: 'string',
            const: 'wisp',
          },
          handle: {
            type: 'string',
            description: 'Subdomain label only (for example, alice).',
            minLength: 3,
            maxLength: 63,
          },
        },
      },
      customRegistration: {
        type: 'object',
        description: 'Registration metadata for a custom domain.',
        required: ['kind', 'challengeId', 'verification'],
        properties: {
          kind: {
            type: 'string',
            const: 'custom',
          },
          challengeId: {
            type: 'string',
            description:
              'Challenge identifier used to derive DNS setup instructions.',
            minLength: 8,
            maxLength: 64,
          },
          verification: {
            type: 'ref',
            ref: 'lex:place.wisp.v2.domains#verification',
          },
        },
      },
      verification: {
        type: 'object',
        description: 'Latest verification state for a custom domain.',
        required: ['status', 'method'],
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'verified', 'failed'],
          },
          method: {
            type: 'string',
            enum: ['txt-did-v1'],
          },
          lastCheckedAt: {
            type: 'string',
            format: 'datetime',
          },
          verifiedAt: {
            type: 'string',
            format: 'datetime',
          },
          lastError: {
            type: 'string',
            maxLength: 1000,
          },
        },
      },
    },
  },
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
              "If true (default), the subfs record's root entries are merged (flattened) into the parent directory, replacing the subfs entry. If false, the subfs entries are placed in a subdirectory with the subfs entry's name. Flat merging is useful for splitting large directories across multiple records while maintaining a flat structure.",
          },
        },
      },
    },
  },
  PlaceWispSettings: {
    lexicon: 1,
    id: 'place.wisp.settings',
    defs: {
      main: {
        type: 'record',
        description:
          'Configuration settings for a static site hosted on wisp.place',
        key: 'any',
        record: {
          type: 'object',
          properties: {
            directoryListing: {
              type: 'boolean',
              description:
                'Enable directory listing mode for paths that resolve to directories without an index file. Incompatible with spaMode.',
              default: false,
            },
            spaMode: {
              type: 'string',
              description:
                "File to serve for all routes (e.g., 'index.html'). When set, enables SPA mode where all non-file requests are routed to this file. Incompatible with directoryListing and custom404.",
              maxLength: 500,
            },
            custom404: {
              type: 'string',
              description:
                'Custom 404 error page file path. Incompatible with directoryListing and spaMode.',
              maxLength: 500,
            },
            indexFiles: {
              type: 'array',
              description:
                "Ordered list of files to try when serving a directory. Defaults to ['index.html'] if not specified.",
              items: {
                type: 'string',
                maxLength: 255,
              },
              maxLength: 10,
            },
            cleanUrls: {
              type: 'boolean',
              description:
                "Enable clean URL routing. When enabled, '/about' will attempt to serve '/about.html' or '/about/index.html' automatically.",
              default: false,
            },
            headers: {
              type: 'array',
              description: 'Custom HTTP headers to set on responses',
              items: {
                type: 'ref',
                ref: 'lex:place.wisp.settings#customHeader',
              },
              maxLength: 50,
            },
          },
        },
      },
      customHeader: {
        type: 'object',
        description: 'Custom HTTP header configuration',
        required: ['name', 'value'],
        properties: {
          name: {
            type: 'string',
            description:
              "HTTP header name (e.g., 'Cache-Control', 'X-Frame-Options')",
            maxLength: 100,
          },
          value: {
            type: 'string',
            description: 'HTTP header value',
            maxLength: 1000,
          },
          path: {
            type: 'string',
            description:
              "Optional glob pattern to apply this header to specific paths (e.g., '*.html', '/assets/*'). If not specified, applies to all paths.",
            maxLength: 500,
          },
        },
      },
    },
  },
  PlaceWispV2SiteDelete: {
    lexicon: 1,
    id: 'place.wisp.v2.site.delete',
    defs: {
      main: {
        type: 'procedure',
        description:
          'Delete one owned site metadata entry and unmap any domains pointing to it.',
        input: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['siteRkey'],
            properties: {
              siteRkey: {
                type: 'string',
                format: 'record-key',
                description:
                  'Owned place.wisp.fs record key to delete from wisp metadata.',
              },
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['siteRkey', 'deleted', 'unmappedDomains'],
            properties: {
              siteRkey: {
                type: 'string',
                format: 'record-key',
              },
              deleted: {
                type: 'boolean',
                const: true,
              },
              unmappedDomains: {
                type: 'array',
                description:
                  'Domains that were detached from this site before deletion.',
                items: {
                  type: 'ref',
                  ref: 'lex:place.wisp.v2.site.delete#unmappedDomain',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'AuthenticationRequired',
          },
          {
            name: 'InvalidRequest',
          },
          {
            name: 'NotFound',
          },
        ],
      },
      unmappedDomain: {
        type: 'object',
        required: ['domain', 'kind', 'status'],
        properties: {
          domain: {
            type: 'string',
            minLength: 3,
            maxLength: 253,
          },
          kind: {
            type: 'string',
            enum: ['wisp', 'custom'],
          },
          status: {
            type: 'string',
            enum: ['pendingVerification', 'verified'],
          },
        },
      },
    },
  },
  PlaceWispV2SiteGetDomains: {
    lexicon: 1,
    id: 'place.wisp.v2.site.getDomains',
    defs: {
      main: {
        type: 'query',
        description: 'List domains currently mapped to a specific site.',
        parameters: {
          type: 'params',
          required: ['did', 'rkey'],
          properties: {
            did: {
              type: 'string',
              format: 'did',
            },
            rkey: {
              type: 'string',
              format: 'record-key',
            },
          },
        },
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['domains'],
            properties: {
              domains: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:place.wisp.v2.site.getDomains#siteDomain',
                },
              },
            },
          },
        },
      },
      siteDomain: {
        type: 'object',
        required: ['domain', 'kind', 'status', 'verified'],
        properties: {
          domain: {
            type: 'string',
            minLength: 3,
            maxLength: 253,
          },
          kind: {
            type: 'string',
            enum: ['wisp', 'custom'],
          },
          status: {
            type: 'string',
            enum: ['pendingVerification', 'verified'],
          },
          verified: {
            type: 'boolean',
          },
        },
      },
    },
  },
  PlaceWispV2SiteGetList: {
    lexicon: 1,
    id: 'place.wisp.v2.site.getList',
    defs: {
      main: {
        type: 'query',
        description:
          'List owned sites and the domains currently mapped to each site.',
        output: {
          encoding: 'application/json',
          schema: {
            type: 'object',
            required: ['sites'],
            properties: {
              sites: {
                type: 'array',
                items: {
                  type: 'ref',
                  ref: 'lex:place.wisp.v2.site.getList#siteSummary',
                },
              },
            },
          },
        },
        errors: [
          {
            name: 'AuthenticationRequired',
          },
        ],
      },
      siteSummary: {
        type: 'object',
        required: ['siteRkey', 'domains'],
        properties: {
          siteRkey: {
            type: 'string',
            format: 'record-key',
          },
          displayName: {
            type: 'string',
            maxLength: 200,
          },
          createdAt: {
            type: 'string',
            format: 'datetime',
          },
          updatedAt: {
            type: 'string',
            format: 'datetime',
          },
          domains: {
            type: 'array',
            items: {
              type: 'ref',
              ref: 'lex:place.wisp.v2.site.getList#siteDomain',
            },
          },
        },
      },
      siteDomain: {
        type: 'object',
        required: ['domain', 'kind', 'status', 'verified'],
        properties: {
          domain: {
            type: 'string',
            minLength: 3,
            maxLength: 253,
          },
          kind: {
            type: 'string',
            enum: ['wisp', 'custom'],
          },
          status: {
            type: 'string',
            enum: ['pendingVerification', 'verified'],
          },
          verified: {
            type: 'boolean',
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
  PlaceWispV2Wh: {
    lexicon: 1,
    id: 'place.wisp.v2.wh',
    defs: {
      main: {
        type: 'record',
        description:
          'Webhook configuration for AT Protocol record events. Fires an HTTP POST to a URL when a matching record event is observed on the firehose.',
        key: 'any',
        record: {
          type: 'object',
          required: ['scope', 'url', 'createdAt'],
          properties: {
            scope: {
              type: 'ref',
              ref: 'lex:place.wisp.v2.wh#atUri',
              description:
                'What to watch. An AT-URI scopes to a specific DID, collection, or record.',
            },
            url: {
              type: 'string',
              format: 'uri',
              maxLength: 2048,
              description: 'HTTPS endpoint to POST the webhook payload to.',
            },
            events: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['create', 'update', 'delete'],
              },
              description:
                'Which record events to trigger on. Defaults to all events if omitted.',
              maxLength: 3,
            },
            secret: {
              type: 'string',
              maxLength: 256,
              description:
                "Optional secret used to sign the webhook payload with HMAC-SHA256. The signature is included in the 'X-Webhook-Signature' header of the webhook request.",
            },
            enabled: {
              type: 'boolean',
              description:
                'Whether the webhook is active. Defaults to true if omitted.',
            },
            createdAt: {
              type: 'string',
              format: 'datetime',
              description: 'Timestamp of when the webhook was created.',
            },
          },
        },
      },
      atUri: {
        type: 'object',
        description:
          'Watch by AT-URI. at://did watches all collections for a DID. at://did/collection watches all records of that collection for a DID. at://did/collection/record watches a specific record.',
        required: ['aturi'],
        properties: {
          aturi: {
            type: 'string',
          },
          backlinks: {
            type: 'boolean',
            description:
              'If true, also watch for records in any repo that reference this DID and collection.',
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
  PlaceWispV2DomainAddSite: 'place.wisp.v2.domain.addSite',
  PlaceWispV2DomainClaimSubdomain: 'place.wisp.v2.domain.claimSubdomain',
  PlaceWispV2DomainClaim: 'place.wisp.v2.domain.claim',
  PlaceWispV2DomainDelete: 'place.wisp.v2.domain.delete',
  PlaceWispV2DomainGetList: 'place.wisp.v2.domain.getList',
  PlaceWispV2DomainGetStatus: 'place.wisp.v2.domain.getStatus',
  PlaceWispV2Domains: 'place.wisp.v2.domains',
  PlaceWispFs: 'place.wisp.fs',
  PlaceWispSettings: 'place.wisp.settings',
  PlaceWispV2SiteDelete: 'place.wisp.v2.site.delete',
  PlaceWispV2SiteGetDomains: 'place.wisp.v2.site.getDomains',
  PlaceWispV2SiteGetList: 'place.wisp.v2.site.getList',
  PlaceWispSubfs: 'place.wisp.subfs',
  PlaceWispV2Wh: 'place.wisp.v2.wh',
} as const
