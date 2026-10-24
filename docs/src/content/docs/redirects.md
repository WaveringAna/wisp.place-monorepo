---
title: Redirects & Rewrites
description: Netlify-style _redirects file support
---

Drop a `_redirects` file in your site's root directory. Each line is a rule — processed top to bottom, first match wins.

```
/from/path    /to/path    [status]
```

## Status Codes

`301` is permanent (default), `302` is temporary, `200` serves new content while keeping the original URL, and `404` serves a custom error page. Append `!` to force a rule even when the source path exists as an actual file.

```
/old-page     /new-page          301
/temp-sale    /sale-page         302
/api/*        /functions/:splat  200
/shop/*       /shop-closed.html  404
/file         /other             200!
```

## Wildcards & Placeholders

`:splat` captures the wildcard match:

```
/news/*         /blog/:splat
/old-site/*     /new-site/:splat
```

Named placeholders for structured URLs:

```
/blog/:year/:month/:day/:slug    /posts/:year-:month-:day/:slug
/products/:category/:id          /shop/:category/item/:id
```

Query parameters work too:

```
/store?id=:id      /products/:id
/search?q=:query   /find/:query
```

## Conditional Redirects

Route based on country (ISO 3166-1 alpha-2), browser language, requested media type, or cookie:

```
/    /us/    302  Country=us
/    /uk/    302  Country=gb

/products    /en/products    301  Language=en
/products    /de/products    301  Language=de

/    /index.json    200!  Accept=application/json,application/ld+json

/*    /legacy/:splat    200  Cookie=is_legacy
```

`Accept=` matches when the request's `Accept` header names one of the listed media types (with a non-zero `q`). A value like `text/*` matches any subtype. Wildcards sent by the client, such as the `*/*` every browser includes, never match, so a browser visiting `/` still gets your HTML while `curl -H 'Accept: application/json'` gets the JSON. Use `200!` when a file already exists at the path, since unforced rules only apply when no file matches.

Responses on paths covered by an `Accept=`, `Language=` or `Cookie=` rule carry a matching `Vary` header, so browsers and caches keep the variants apart.

## Common Patterns

```
# SPA fallback
/*    /index.html    200

# API proxy
/api/*    https://api.example.com/:splat    200

# Remove .html extensions
/page.html    /page

# Full example
/blog/*             /posts/:splat                            301
/api/*              https://api.example.com/:splat           200
/                   /us/                                     302  Country=us
/                   /uk/                                     302  Country=gb
/*                  /index.html                              200
```
