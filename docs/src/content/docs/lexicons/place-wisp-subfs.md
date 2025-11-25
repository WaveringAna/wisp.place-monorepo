---
title: place.wisp.subfs
description: Reference for the place.wisp.subfs lexicon
---

**Lexicon Version:** 1

## Overview

The `place.wisp.subfs` lexicon defines subtree records for splitting large sites across multiple AT Protocol records. When a site exceeds size limits (250+ files or 140KB manifest), large directories are extracted into separate `place.wisp.subfs` records.

**Key Feature:** Subfs entries are referenced from `place.wisp.fs` records and can be either **merged (flattened)** into the parent directory or placed as a subdirectory, depending on the `flat` property in the parent `place.wisp.fs` record.

## Record Structure

<a name="main"></a>

### `main` (Record)

**Type:** `record`

**Description:** Virtual filesystem subtree referenced by place.wisp.fs records. How this subtree is integrated depends on the `flat` property in the referencing subfs entry.

**Properties:**

| Name        | Type                       | Req'd | Description                               | Constraints        |
| ----------- | -------------------------- | ----- | ----------------------------------------- | ------------------ |
| `root`      | [`#directory`](#directory) | ✅     | Root directory containing subtree entries |                    |
| `fileCount` | `integer`                  |       | Number of files in this subtree           | Min: 0, Max: 1000  |
| `createdAt` | `string`                   | ✅     | Timestamp of subtree creation             | Format: `datetime` |

---

## Type Definitions

<a name="file"></a>

### `file`

**Type:** `object`

**Description:** Represents a file node in the directory tree

**Properties:**

| Name       | Type      | Req'd | Description                                                  | Constraints               |
| ---------- | --------- | ----- | ------------------------------------------------------------ | ------------------------- |
| `type`     | `string`  | ✅     | Node type identifier                                         | Const: `"file"`           |
| `blob`     | `blob`    | ✅     | Content blob reference                                       | Max size: 1000000000 (1GB) |
| `encoding` | `string`  |       | Content encoding (e.g., gzip for compressed files)           | Enum: `["gzip"]`          |
| `mimeType` | `string`  |       | Original MIME type before compression                        |                           |
| `base64`   | `boolean` |       | True if blob content is base64-encoded (bypasses PDS sniffing) |                         |

---

<a name="directory"></a>

### `directory`

**Type:** `object`

**Description:** Represents a directory node in the file tree

**Properties:**

| Name      | Type                       | Req'd | Description                    | Constraints          |
| --------- | -------------------------- | ----- | ------------------------------ | -------------------- |
| `type`    | `string`                   | ✅     | Node type identifier           | Const: `"directory"` |
| `entries` | Array of [`#entry`](#entry) | ✅     | Child entries in this directory | Max: 500 entries     |

---

<a name="entry"></a>

### `entry`

**Type:** `object`

**Description:** Named entry in a directory (file, directory, or nested subfs)

**Properties:**

| Name   | Type                                                    | Req'd | Description                         | Constraints |
| ------ | ------------------------------------------------------- | ----- | ----------------------------------- | ----------- |
| `name` | `string`                                                | ✅     | File or directory name              | Max: 255 chars |
| `node` | Union of [`#file`](#file), [`#directory`](#directory), [`#subfs`](#subfs) | ✅     | The node (file, directory, or subfs reference) |             |

---

<a name="subfs"></a>

### `subfs`

**Type:** `object`

**Description:** Reference to another `place.wisp.subfs` record for nested subtrees. When expanded, entries are merged (flattened) into the parent directory by default, unless the parent `place.wisp.fs` record specifies `flat: false`.

**Properties:**

| Name      | Type     | Req'd | Description                                                                 | Constraints      |
| --------- | -------- | ----- | --------------------------------------------------------------------------- | ---------------- |
| `type`    | `string` | ✅     | Node type identifier                                                        | Const: `"subfs"` |
| `subject` | `string` | ✅     | AT-URI pointing to another place.wisp.subfs record for nested subtrees      | Format: `at-uri` |

**Notes:**
- Subfs records can reference other subfs records recursively
- When expanded, entries are merged (flattened) into the parent directory by default
- The `flat` property in the parent `place.wisp.fs` record controls integration behavior
- Allows splitting very large directory structures

---

## How Subfs Merging Works

### Before Expansion

Main record (`place.wisp.fs`):
```json
{
  "root": {
    "type": "directory",
    "entries": [
      { "name": "index.html", "node": { "type": "file", ... } },
      { "name": "docs", "node": { "type": "subfs", "subject": "at://did:plc:abc/place.wisp.subfs/xyz" } }
    ]
  }
}
```

Referenced subfs record (`at://did:plc:abc/place.wisp.subfs/xyz`):
```json
{
  "root": {
    "type": "directory",
    "entries": [
      { "name": "guide.html", "node": { "type": "file", ... } },
      { "name": "api.html", "node": { "type": "file", ... } }
    ]
  }
}
```

### After Expansion (What Hosting Service Sees)

**With `flat: true` (default):**

```json
{
  "root": {
    "type": "directory",
    "entries": [
      { "name": "index.html", "node": { "type": "file", ... } },
      { "name": "guide.html", "node": { "type": "file", ... } },
      { "name": "api.html", "node": { "type": "file", ... } }
    ]
  }
}
```

The subfs entries are merged directly into the parent directory.

**With `flat: false`:**

```json
{
  "root": {
    "type": "directory",
    "entries": [
      { "name": "index.html", "node": { "type": "file", ... } },
      { "name": "docs", "node": { 
        "type": "directory",
        "entries": [
          { "name": "guide.html", "node": { "type": "file", ... } },
          { "name": "api.html", "node": { "type": "file", ... } }
        ]
      }}
    ]
  }
}
```

The subfs entries are placed in a subdirectory named "docs".

---

## Usage Examples

### Basic Subfs Record

```json
{
  "$type": "place.wisp.subfs",
  "root": {
    "type": "directory",
    "entries": [
      {
        "name": "chapter1.html",
        "node": {
          "type": "file",
          "blob": {
            "$type": "blob",
            "ref": { "$link": "bafyreiabc..." },
            "mimeType": "application/octet-stream",
            "size": 8421
          },
          "encoding": "gzip",
          "mimeType": "text/html",
          "base64": true
        }
      },
      {
        "name": "chapter2.html",
        "node": {
          "type": "file",
          "blob": {
            "$type": "blob",
            "ref": { "$link": "bafyreidef..." },
            "mimeType": "application/octet-stream",
            "size": 9234
          },
          "encoding": "gzip",
          "mimeType": "text/html",
          "base64": true
        }
      }
    ]
  },
  "fileCount": 2,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

### Nested Subfs (Recursive)

A subfs record can reference another subfs record:

```json
{
  "$type": "place.wisp.subfs",
  "root": {
    "type": "directory",
    "entries": [
      {
        "name": "section-a.html",
        "node": { "type": "file", "blob": {...}, "encoding": "gzip", "mimeType": "text/html", "base64": true }
      },
      {
        "name": "subsection",
        "node": {
          "type": "subfs",
          "subject": "at://did:plc:abc123/place.wisp.subfs/nested123"
        }
      }
    ]
  },
  "fileCount": 50,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

---

## When Are Subfs Records Created?

The Wisp CLI and web interface automatically create subfs records when:

1. **File count threshold**: Site has 250+ files (keeps main manifest under 200 files)
2. **Size threshold**: Main manifest exceeds 140KB (PDS limit is 150KB)
3. **Large directories**: Individual directories with many files

### Splitting Algorithm

The `flat` property in the parent `place.wisp.fs` record controls integration behavior:
- `flat: true` (default): Merge subfs entries directly into parent directory
- `flat: false`: Create subdirectory with the subfs entry's name

---

## Best Practices

### For Hosting Services

- **Fetch recursively**: Load all subfs records referenced in the tree
- **Merge entries**: Replace subfs nodes with directory nodes containing referenced entries
- **Cache merged tree**: Store the fully expanded tree for serving
- **Update on firehose**: Re-fetch and re-merge when subfs records change

### For Upload Tools

- **Reuse subfs records**: Check existing subfs URIs before creating new ones
- **Clean up old records**: Delete unused subfs records after updates
- **Maintain file paths**: Preserve original directory structure when extracting to subfs

---

## Lexicon Source

```json
{
  "lexicon": 1,
  "id": "place.wisp.subfs",
  "defs": {
    "main": {
      "type": "record",
      "description": "Virtual filesystem subtree referenced by place.wisp.fs records. When a subfs entry is expanded, its root entries are merged (flattened) into the parent directory, allowing large directories to be split across multiple records while maintaining a flat structure.",
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
        "subject": { "type": "string", "format": "at-uri", "description": "AT-URI pointing to another place.wisp.subfs record for nested subtrees. Integration behavior (flat vs nested) is controlled by the flat property in the parent place.wisp.fs record." }
      }
    }
  }
}
```

## Related

- [place.wisp.fs](/lexicons/place-wisp-fs) - Main site manifest lexicon
- [AT Protocol Lexicons](https://atproto.com/specs/lexicon)

