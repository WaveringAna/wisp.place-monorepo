---
title: Lexicon Reference
description: AT Protocol lexicons used by Wisp.place
---

Wisp.place uses three custom AT Protocol lexicons to store site data in your PDS.

**[place.wisp.fs](/lexicons/place-wisp-fs)** — the main site manifest. Stores the full directory tree with references to file blobs.

**[place.wisp.subfs](/lexicons/place-wisp-subfs)** — subtree records for splitting large sites across multiple records. Entries from subfs records are merged into the parent directory.

**[place.wisp.domain](/lexicons/place-wisp-domain)** — metadata record for claiming a wisp.place subdomain.

**[place.wisp.v2.wh](/lexicons/place-wisp-wh)** — webhook record for receiving HTTP callbacks when AT Protocol records change.

**place.wisp.v2.secret.{create,list,delete,rotate}** — server-managed signing secrets for webhooks. Tokens are returned once at creation and never stored in plaintext. See the [webhooks doc](/lexicons/place-wisp-wh#signing-secrets-api) for usage.

## Storage Model

Sites are stored as `place.wisp.fs` records in your AT Protocol repository:

```
at://did:plc:abc123/place.wisp.fs/my-site
```

Files are gzipped for compression and uploaded as `application/octet-stream` blobs. They may also be base64-encoded to bypass content sniffing on legacy reference PDS. The original MIME type is preserved in the manifest.

Sites with 250+ files are automatically split: large directories are extracted into `place.wisp.subfs` records, referenced by AT-URI from the main manifest, and merged back together by the hosting service at serve time. This keeps the main manifest under the 150 KB PDS record size limit.

## Example Record

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
      }
    ]
  },
  "fileCount": 42,
  "createdAt": "2024-01-15T10:30:00Z"
}
```
