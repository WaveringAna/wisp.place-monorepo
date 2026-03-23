---
title: place.wisp.subfs
description: Reference for the place.wisp.subfs lexicon
---

Subtree records for splitting large sites across multiple AT Protocol records. When a site exceeds 250 files or 140 KB, large directories are extracted into `place.wisp.subfs` records and referenced from the main `place.wisp.fs` manifest.

**Lexicon version:** 1

## main (record)

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `root` | [`#directory`](#directory) | ✅ | Root directory of the subtree |
| `fileCount` | `integer` | | Min: 0, Max: 1000 |
| `createdAt` | `string` | ✅ | Format: `datetime` |

## file

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `type` | `string` | ✅ | Const: `"file"` |
| `blob` | `blob` | ✅ | Max size: 1 GB |
| `encoding` | `string` | | Enum: `["gzip"]` |
| `mimeType` | `string` | | Original MIME type |
| `base64` | `boolean` | | True if base64-encoded to bypass content sniffing on legacy reference PDS |

## directory

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `type` | `string` | ✅ | Const: `"directory"` |
| `entries` | Array of [`#entry`](#entry) | ✅ | Max: 500 entries |

## entry

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | `string` | ✅ | Max: 255 chars |
| `node` | Union of [`#file`](#file), [`#directory`](#directory), [`#subfs`](#subfs) | ✅ | |

## subfs

Reference to another `place.wisp.subfs` record for nested subtrees. Subfs records can reference other subfs records recursively.

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `type` | `string` | ✅ | Const: `"subfs"` |
| `subject` | `string` | ✅ | AT-URI to another `place.wisp.subfs` record |

## How Merging Works

The `flat` property on the referencing entry in `place.wisp.fs` controls how subfs entries are integrated.

**With `flat: true` (default)** — subfs entries are merged directly into the parent directory:

```
Main fs root/
├── index.html
└── [subfs ref] ──→ { guide.html, api.html }

After expansion:
├── index.html
├── guide.html
└── api.html
```

**With `flat: false`** — subfs entries become a subdirectory:

```
After expansion:
├── index.html
└── docs/
    ├── guide.html
    └── api.html
```

## Lexicon Source

```json
{
  "lexicon": 1,
  "id": "place.wisp.subfs",
  "defs": {
    "main": {
      "type": "record",
      "record": {
        "type": "object",
        "required": ["root", "createdAt"],
        "properties": {
          "root": { "type": "ref", "ref": "#directory" },
          "fileCount": { "type": "integer", "minimum": 0, "maximum": 1000 },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    },
    "file": {
      "type": "object",
      "required": ["type", "blob"],
      "properties": {
        "type": { "type": "string", "const": "file" },
        "blob": { "type": "blob", "accept": ["*/*"], "maxSize": 1000000000 },
        "encoding": { "type": "string", "enum": ["gzip"] },
        "mimeType": { "type": "string" },
        "base64": { "type": "boolean" }
      }
    },
    "directory": {
      "type": "object",
      "required": ["type", "entries"],
      "properties": {
        "type": { "type": "string", "const": "directory" },
        "entries": { "type": "array", "maxLength": 500, "items": { "type": "ref", "ref": "#entry" } }
      }
    },
    "entry": {
      "type": "object",
      "required": ["name", "node"],
      "properties": {
        "name": { "type": "string", "maxLength": 255 },
        "node": { "type": "union", "refs": ["#file", "#directory", "#subfs"] }
      }
    },
    "subfs": {
      "type": "object",
      "required": ["type", "subject"],
      "properties": {
        "type": { "type": "string", "const": "subfs" },
        "subject": { "type": "string", "format": "at-uri" }
      }
    }
  }
}
```
