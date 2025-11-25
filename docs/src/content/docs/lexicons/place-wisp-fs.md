---
title: place.wisp.fs
description: Reference for the place.wisp.fs lexicon
---

**Lexicon Version:** 1

## Overview

The `place.wisp.fs` lexicon defines the structure for storing static site manifests in AT Protocol repositories. Each record represents a complete website with its directory structure and file references.

## Record Structure

<a name="main"></a>

### `main` (Record)

**Type:** `record`

**Description:** Virtual filesystem manifest for a Wisp site

**Properties:**

| Name        | Type                        | Req'd | Description                          | Constraints        |
| ----------- | --------------------------- | ----- | ------------------------------------ | ------------------ |
| `site`      | `string`                    | ✅     | Site name (used as record key)       |                    |
| `root`      | [`#directory`](#directory)  | ✅     | Root directory of the site           |                    |
| `fileCount` | `integer`                   |       | Total number of files in the site    | Min: 0, Max: 1000  |
| `createdAt` | `string`                    | ✅     | Timestamp of site creation/update    | Format: `datetime` |

---

<a name="entry"></a>

### `entry`

**Type:** `object`

**Description:** Named entry in a directory (file, directory, or subfs)

**Properties:**

| Name   | Type                                                    | Req'd | Description                         | Constraints |
| ------ | ------------------------------------------------------- | ----- | ----------------------------------- | ----------- |
| `name` | `string`                                                | ✅     | File or directory name              | Max: 255 chars |
| `node` | Union of [`#file`](#file), [`#directory`](#directory), [`#subfs`](#subfs) | ✅     | The node (file, directory, or subfs reference) |             |

---

## Type Definitions

<a name="file"></a>

### `file`

**Type:** `object`

**Description:** Represents a file node in the directory tree

**Properties:**

| Name       | Type      | Req'd | Description                                                  | Constraints            |
| ---------- | --------- | ----- | ------------------------------------------------------------ | ---------------------- |
| `type`     | `string`  | ✅     | Node type identifier                                         | Const: `"file"`        |
| `blob`     | `blob`    | ✅     | Content blob reference                                       | Max size: 1000000000 (1GB) |
| `encoding` | `string`  |       | Content encoding (e.g., gzip for compressed files)           | Enum: `["gzip"]`       |
| `mimeType` | `string`  |       | Original MIME type before compression                        |                        |
| `base64`   | `boolean` |       | True if blob content is base64-encoded (bypasses PDS sniffing) |                      |

**Notes:**
- Files are typically gzip compressed before upload
- Text files (HTML/CSS/JS) are also base64 encoded to prevent PDS content-type sniffing
- The blob is uploaded with MIME type `application/octet-stream`
- Original MIME type is preserved in the `mimeType` field

---

<a name="directory"></a>

### `directory`

**Type:** `object`

**Description:** Represents a directory node in the file tree

**Properties:**

| Name      | Type                       | Req'd | Description                    | Constraints |
| --------- | -------------------------- | ----- | ------------------------------ | ----------- |
| `type`    | `string`                   | ✅     | Node type identifier           | Const: `"directory"` |
| `entries` | Array of [`#entry`](#entry) | ✅     | Child entries in this directory | Max: 500 entries |

**Notes:**
- Directories can contain files, subdirectories, or subfs references
- Maximum 500 entries per directory to stay within record size limits

<a name="subfs"></a>

### `subfs`

**Type:** `object`

**Description:** Reference to a `place.wisp.subfs` record for splitting large directories

**Properties:**

| Name      | Type     | Req'd | Description                                                                 | Constraints      |
| --------- | -------- | ----- | --------------------------------------------------------------------------- | ---------------- |
| `type`    | `string` | ✅     | Node type identifier                                                        | Const: `"subfs"` |
| `subject` | `string` | ✅     | AT-URI pointing to a place.wisp.subfs record containing this subtree        | Format: `at-uri` |
| `flat`    | `boolean` |       | Controls merging behavior (default: true)                                   |                  |

**Notes:**
- When `flat` is true (default), the subfs record's root entries are **merged (flattened)** into the parent directory
- When `flat` is false, the subfs entries are placed in a subdirectory with the subfs entry's name
- The `flat` property controls whether the subfs acts as a content merge or directory replacement
- Allows splitting large directories across multiple records while optionally maintaining flat or nested structure
- Used automatically when sites exceed 250 files or 140KB manifest size

---

## Usage Examples

### Simple Site

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
          "blob": {
            "$type": "blob",
            "ref": { "$link": "bafyreiabc..." },
            "mimeType": "application/octet-stream",
            "size": 4521
          },
          "encoding": "gzip",
          "mimeType": "text/html",
          "base64": true
        }
      },
      {
        "name": "style.css",
        "node": {
          "type": "file",
          "blob": {
            "$type": "blob",
            "ref": { "$link": "bafyreidef..." },
            "mimeType": "application/octet-stream",
            "size": 2134
          },
          "encoding": "gzip",
          "mimeType": "text/css",
          "base64": true
        }
      }
    ]
  },
  "fileCount": 2,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

### Site with Subdirectory

```json
{
  "$type": "place.wisp.fs",
  "site": "portfolio",
  "root": {
    "type": "directory",
    "entries": [
      {
        "name": "index.html",
        "node": { "type": "file", "blob": {...}, "encoding": "gzip", "mimeType": "text/html", "base64": true }
      },
      {
        "name": "assets",
        "node": {
          "type": "directory",
          "entries": [
            {
              "name": "logo.png",
              "node": { "type": "file", "blob": {...}, "encoding": "gzip", "mimeType": "image/png", "base64": false }
            }
          ]
        }
      }
    ]
  },
  "fileCount": 2,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

### Large Site with Subfs

```json
{
  "$type": "place.wisp.fs",
  "site": "documentation",
  "root": {
    "type": "directory",
    "entries": [
      {
        "name": "index.html",
        "node": { "type": "file", "blob": {...}, "encoding": "gzip", "mimeType": "text/html", "base64": true }
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
        "blob": { "type": "blob", "accept": ["*/*"], "maxSize": 1000000000, "description": "Content blob ref" },
        "encoding": { "type": "string", "enum": ["gzip"], "description": "Content encoding (e.g., gzip for compressed files)" },
        "mimeType": { "type": "string", "description": "Original MIME type before compression" },
        "base64": { "type": "boolean", "description": "True if blob content is base64-encoded (used to bypass PDS content sniffing)" }
      }
    },
    "directory": {
      "type": "object",
      "required": ["type", "entries"],
      "properties": {
        "type": { "type": "string", "const": "directory" },
        "entries": {
          "type": "array",
          "maxLength": 500,
          "items": { "type": "ref", "ref": "#entry" }
        }
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
        "subject": { "type": "string", "format": "at-uri", "description": "AT-URI pointing to a place.wisp.subfs record containing this subtree." },
        "flat": { "type": "boolean", "description": "If true (default), the subfs record's root entries are merged (flattened) into the parent directory, replacing the subfs entry. If false, the subfs entries are placed in a subdirectory with the subfs entry's name. Flat merging is useful for splitting large directories across multiple records while maintaining a flat structure." }
      }
    }
  }
}
```

## Related

- [place.wisp.subfs](/lexicons/place-wisp-subfs) - Subtree records for large sites
- [AT Protocol Lexicons](https://atproto.com/specs/lexicon)

