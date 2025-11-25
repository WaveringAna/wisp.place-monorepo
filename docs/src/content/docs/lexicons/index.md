---
title: Lexicon Reference
description: AT Protocol lexicons used by Wisp.place
---

Wisp.place uses custom AT Protocol lexicons to store and manage static site data. These lexicons define the structure of records stored in your PDS.

## Available Lexicons

### [place.wisp.fs](/lexicons/place-wisp-fs)
The main lexicon for storing static site manifests. Contains the directory tree structure with references to file blobs.

### [place.wisp.subfs](/lexicons/place-wisp-subfs)
Subtree lexicon for splitting large sites across multiple records. Entries from subfs records are merged (flattened) into the parent directory.

### [place.wisp.domain](/lexicons/place-wisp-domain)
Domain registration record for claiming wisp.place subdomains.

## How Lexicons Work

### Storage Model

Sites are stored as `place.wisp.fs` records in your AT Protocol repository:

```
at://did:plc:abc123/place.wisp.fs/my-site
```

Each record contains:
- **Site metadata** (name, file count, timestamps)
- **Directory tree** (hierarchical structure)
- **Blob references** (content-addressed file storage)

### File Processing

1. Files are **gzipped** for compression
2. Text files are **base64 encoded** to bypass PDS content sniffing
3. Uploaded as blobs with `application/octet-stream` MIME type
4. Original MIME type stored in manifest metadata

### Large Site Splitting

Sites with 250+ files are automatically split:

1. Large directories are extracted into `place.wisp.subfs` records
2. Main manifest references subfs records via AT-URI
3. Hosting services merge (flatten) subfs entries when serving
4. Keeps manifest size under 150KB PDS limit

## Example Record Structure

```json
{
  "$type": "place.wisp.fs",
  "site": "my-site",
  "root": {
    "type": "directory",
    "entries": [
      {
        "name": "index.html",
        "node": {
          "type": "file",
          "blob": {
            "$type": "blob",
            "ref": { "$link": "bafyreiabc123..." },
            "mimeType": "application/octet-stream",
            "size": 12345
          },
          "encoding": "gzip",
          "mimeType": "text/html",
          "base64": true
        }
      },
      {
        "name": "assets",
        "node": {
          "type": "directory",
          "entries": [...]
        }
      }
    ]
  },
  "fileCount": 42,
  "createdAt": "2024-01-15T10:30:00Z"
}
```

## Learn More

- [place.wisp.fs Reference](/lexicons/place-wisp-fs)
- [place.wisp.subfs Reference](/lexicons/place-wisp-subfs)
- [place.wisp.domain Reference](/lexicons/place-wisp-domain)
- [AT Protocol Lexicons](https://atproto.com/specs/lexicon)

