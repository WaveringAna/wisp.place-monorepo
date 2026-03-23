---
title: place.wisp.fs
description: Reference for the place.wisp.fs lexicon
---

The main lexicon for storing static site manifests. Each record represents a complete website with its directory tree and file blob references.

**Lexicon version:** 1

## main (record)

Virtual filesystem manifest for a Wisp site.

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `site` | `string` | ✅ | Site name (used as record key) |
| `root` | [`#directory`](#directory) | ✅ | Root directory |
| `fileCount` | `integer` | | Min: 0, Max: 1000 |
| `createdAt` | `string` | ✅ | Format: `datetime` |

## entry

A named entry in a directory.

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | `string` | ✅ | Max: 255 chars |
| `node` | Union of [`#file`](#file), [`#directory`](#directory), [`#subfs`](#subfs) | ✅ | |

## file

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `type` | `string` | ✅ | Const: `"file"` |
| `blob` | `blob` | ✅ | Max size: 1 GB |
| `encoding` | `string` | | Enum: `["gzip"]` |
| `mimeType` | `string` | | Original MIME type before compression |
| `base64` | `boolean` | | True if blob is base64-encoded |

Files are gzip-compressed before upload and uploaded as `application/octet-stream`. They may also be base64-encoded to bypass content sniffing on legacy reference PDS. The original MIME type is stored in `mimeType`.

## directory

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `type` | `string` | ✅ | Const: `"directory"` |
| `entries` | Array of [`#entry`](#entry) | ✅ | Max: 500 entries |

## subfs

Reference to a `place.wisp.subfs` record for splitting large directories.

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `type` | `string` | ✅ | Const: `"subfs"` |
| `subject` | `string` | ✅ | AT-URI to a `place.wisp.subfs` record |
| `flat` | `boolean` | | Default: `true` |

When `flat` is true (default), the subfs record's entries are merged directly into the parent directory. When `flat` is false, entries are placed in a subdirectory named after the subfs entry. Used automatically when sites exceed 250 files or 140 KB.

## Examples

### Simple site

```json
{
  "$type": "place.wisp.fs",
  "site": "my-blog",
  "root": {
    "type": "directory",
    "entries": [
      {
        "name": "index.html",
        "node": {
          "type": "file",
          "blob": { "$type": "blob", "ref": { "$link": "bafyreiabc..." }, "mimeType": "application/octet-stream", "size": 4521 },
          "encoding": "gzip",
          "mimeType": "text/html",
          "base64": true
        }
      }
    ]
  },
  "fileCount": 1,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

### Large site with subfs

```json
{
  "$type": "place.wisp.fs",
  "site": "documentation",
  "root": {
    "type": "directory",
    "entries": [
      {
        "name": "index.html",
        "node": { "type": "file", "blob": { ... }, "encoding": "gzip", "mimeType": "text/html", "base64": true }
      },
      {
        "name": "docs",
        "node": {
          "type": "subfs",
          "subject": "at://did:plc:abc123/place.wisp.subfs/3kl2jd9s8f7g",
          "flat": true
        }
      }
    ]
  },
  "fileCount": 150,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

## Lexicon Source

```json
{
  "lexicon": 1,
  "id": "place.wisp.fs",
  "defs": {
    "main": {
      "type": "record",
      "description": "Virtual filesystem manifest for a Wisp site",
      "record": {
        "type": "object",
        "required": ["site", "root", "createdAt"],
        "properties": {
          "site": { "type": "string" },
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
        "subject": { "type": "string", "format": "at-uri" },
        "flat": { "type": "boolean" }
      }
    }
  }
}
```
