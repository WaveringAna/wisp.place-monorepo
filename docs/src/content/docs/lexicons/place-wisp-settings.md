---
title: place.wisp.settings
description: Reference for the place.wisp.settings lexicon
---

Per-site configuration: routing behavior, index files, directory listing, and custom HTTP headers. The hosting service reads this record when serving a site to decide how paths resolve and what headers to attach.

**Lexicon version:** 1

The record key (`key: "any"`) is the site name it configures, matching the corresponding [`place.wisp.fs`](/lexicons/place-wisp-fs) record key. A site without a `place.wisp.settings` record falls back to default behavior.

## main (record)

Configuration settings for a static site hosted on wisp.place. All properties are optional.

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `directoryListing` | `boolean` | | Default: `false`. Incompatible with `spaMode` |
| `spaMode` | `string` | | Max: 500 chars. Incompatible with `directoryListing` and `custom404` |
| `custom404` | `string` | | Max: 500 chars. Incompatible with `directoryListing` and `spaMode` |
| `indexFiles` | `string[]` | | Max: 10 items, each ≤ 255 chars |
| `cleanUrls` | `boolean` | | Default: `false` |
| `headers` | Array of [`#customHeader`](#customheader) | | Max: 50 entries |

### Property behavior

- **`directoryListing`** — when a path resolves to a directory without a matching index file, render an auto-generated listing of its contents instead of returning 404.
- **`spaMode`** — file to serve for all non-file routes (e.g. `index.html`). Enables single-page-app routing where unknown paths fall through to this file rather than 404ing.
- **`custom404`** — file path to serve for missing routes (e.g. `404.html`).
- **`indexFiles`** — ordered list of filenames tried when serving a directory. Defaults to `["index.html"]` when unset. The first match wins.
- **`cleanUrls`** — when enabled, `/about` will attempt `/about.html` then `/about/index.html` automatically, allowing extensionless URLs.

The three routing modes — `directoryListing`, `spaMode`, and `custom404` — are mutually exclusive in the combinations noted above, since each defines a different fallback for unmatched paths.

## customHeader

Custom HTTP header configuration. Added to responses served for the site.

| Property | Type | Required | Constraints |
| --- | --- | --- | --- |
| `name` | `string` | ✅ | Max: 100 chars (e.g. `Cache-Control`, `X-Frame-Options`) |
| `value` | `string` | ✅ | Max: 1000 chars |
| `path` | `string` | | Max: 500 chars. Optional glob pattern (e.g. `*.html`, `/assets/*`) |

When `path` is omitted, the header applies to all responses. When set, it applies only to paths matching the glob.

## Examples

### Clean URLs with a custom 404

```json
{
  "$type": "place.wisp.settings",
  "cleanUrls": true,
  "custom404": "404.html",
  "indexFiles": ["index.html", "index.htm"]
}
```

### Single-page app with caching headers

```json
{
  "$type": "place.wisp.settings",
  "spaMode": "index.html",
  "headers": [
    {
      "name": "Cache-Control",
      "value": "public, max-age=31536000, immutable",
      "path": "/assets/*"
    },
    {
      "name": "X-Frame-Options",
      "value": "DENY"
    }
  ]
}
```

### Directory listing

```json
{
  "$type": "place.wisp.settings",
  "directoryListing": true
}
```

## Lexicon Source

```json
{
  "lexicon": 1,
  "id": "place.wisp.settings",
  "defs": {
    "main": {
      "type": "record",
      "description": "Configuration settings for a static site hosted on wisp.place",
      "key": "any",
      "record": {
        "type": "object",
        "properties": {
          "directoryListing": {
            "type": "boolean",
            "description": "Enable directory listing mode for paths that resolve to directories without an index file. Incompatible with spaMode.",
            "default": false
          },
          "spaMode": {
            "type": "string",
            "description": "File to serve for all routes (e.g., 'index.html'). When set, enables SPA mode where all non-file requests are routed to this file. Incompatible with directoryListing and custom404.",
            "maxLength": 500
          },
          "custom404": {
            "type": "string",
            "description": "Custom 404 error page file path. Incompatible with directoryListing and spaMode.",
            "maxLength": 500
          },
          "indexFiles": {
            "type": "array",
            "description": "Ordered list of files to try when serving a directory. Defaults to ['index.html'] if not specified.",
            "items": { "type": "string", "maxLength": 255 },
            "maxLength": 10
          },
          "cleanUrls": {
            "type": "boolean",
            "description": "Enable clean URL routing. When enabled, '/about' will attempt to serve '/about.html' or '/about/index.html' automatically.",
            "default": false
          },
          "headers": {
            "type": "array",
            "description": "Custom HTTP headers to set on responses",
            "items": { "type": "ref", "ref": "#customHeader" },
            "maxLength": 50
          }
        }
      }
    },
    "customHeader": {
      "type": "object",
      "description": "Custom HTTP header configuration",
      "required": ["name", "value"],
      "properties": {
        "name": { "type": "string", "description": "HTTP header name (e.g., 'Cache-Control', 'X-Frame-Options')", "maxLength": 100 },
        "value": { "type": "string", "description": "HTTP header value", "maxLength": 1000 },
        "path": { "type": "string", "description": "Optional glob pattern to apply this header to specific paths (e.g., '*.html', '/assets/*'). If not specified, applies to all paths.", "maxLength": 500 }
      }
    }
  }
}
```
