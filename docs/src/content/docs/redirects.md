---
title: Redirects & Rewrites
description: Netlify-style _redirects file support for flexible URL routing
---

# Redirects & Rewrites

Wisp.place supports Netlify-style `_redirects` files, giving you powerful control over URL routing and redirects. Whether you're migrating an old site, setting up a single-page app, or creating clean URLs, the `_redirects` file lets you handle complex routing scenarios without changing your actual file structure.

## Getting Started

Drop a file named `_redirects` in your site's root directory. Each line defines a redirect rule with the format:

```
/from/path    /to/path    [status]    [conditions]
```

For example:
```
/old-page     /new-page
/blog/*       /posts/:splat    301
```

## Basic Redirects

The simplest redirects move traffic from one URL to another:

```
/home              /
/about-us          /about
/old-blog          /blog
```

These use a permanent redirect (301) by default, telling browsers and search engines the page has moved permanently.

## Status Codes

You can specify different HTTP status codes to change how the redirect behaves:

**301 - Permanent Redirect**
```
/legacy-page    /new-page    301
```
Tells browsers and search engines the page has moved permanently. Good for SEO when content has truly moved.

**302 - Temporary Redirect**
```
/temp-sale      /sale-page   302
```
Indicates a temporary move. Browsers won't cache this as strongly, and search engines won't transfer SEO value.

**200 - Rewrite**
```
/api/*         /functions/:splat    200
```
Serves different content but keeps the original URL visible to users. Perfect for API routing or single-page apps.

**404 - Custom Error Page**
```
/shop/*        /shop-closed.html    404
```
Shows a custom error page instead of the default 404. Useful for seasonal closures or section-specific error handling.

**Force with `!`**
```
/existing-file  /other-file  200!
```
Normally, if the original path exists as a file, the redirect won't trigger. Add `!` to force it anyway.

## Wildcard Redirects

Splats (`*`) let you match entire path segments:

**Simple wildcards:**
```
/news/*         /blog/:splat
/old-site/*     /new-site/:splat
```

If someone visits `/news/tech-update`, they'll be redirected to `/blog/tech-update`.

**Multiple wildcards:**
```
/products/*/details/*    /shop/:splat/info/:splat
```

This captures multiple path segments and maps them to the new structure.

## Placeholders

Placeholders let you restructure URLs with named parameters:

```
/blog/:year/:month/:day/:slug    /posts/:year-:month-:day/:slug
/products/:category/:id          /shop/:category/item/:id
```

These are more precise than splats because you can reference the captured values by name. Visiting `/blog/2024/01/15/my-post` redirects to `/posts/2024-01-15/my-post`.

## Query Parameters

You can match and redirect based on URL parameters:

```
/store?id=:id      /products/:id
/search?q=:query   /find/:query
```

The query parameter becomes part of the redirect path. `/store?id=123` becomes `/products/123`.

## Conditional Redirects

Make redirects happen only under certain conditions:

**Country-based:**
```
/                  /us/         302  Country=us
/                  /uk/         302  Country=gb
```

Redirects users based on their country (using ISO 3166-1 alpha-2 codes).

**Language-based:**
```
/products          /en/products      301  Language=en
/products          /de/products      301  Language=de
```

Routes based on browser language preferences.

**Cookie-based:**
```
/*                 /legacy/:splat    200  Cookie=is_legacy
```

Only redirects if the user has a specific cookie set.

## Advanced Patterns

**Single-page app routing:**
```
/*                 /index.html      200
```

Send all unmatched routes to your main app file. Perfect for React, Vue, or Angular apps.

**API proxying:**
```
/api/*            https://api.example.com/:splat    200
```

Proxy API calls to external services while keeping the URL clean.

**Domain redirects:**
```
http://blog.example.com/*     https://example.com/blog/:splat    301!
```

Redirect from subdomains or entirely different domains.

**Extension removal:**
```
/page.html         /page
```

Clean up old `.html` extensions for a modern look.

## How It Works

1. **Processing order:** Rules are checked from top to bottom - first match wins
2. **Specificity:** More specific rules should come before general ones
3. **Caching:** Redirects are cached for performance but respect the site's cache headers
4. **Performance:** All processing happens at the edge, close to your users

## Examples

Here's a complete `_redirects` file for a typical site migration:

```
# Old blog structure to new
/blog/*             /posts/:splat      301

# API proxy
/api/*              https://api.example.com/:splat    200

# Country redirects for homepage
/                   /us/               302  Country=us
/                   /uk/               302  Country=gb

# Single-page app fallback
/*                  /index.html        200

# Custom 404 for shop section
/shop/*             /shop/closed.html  404
```

## Tips

- **Order matters:** Put specific rules before general ones
- **Test thoroughly:** Use the preview feature to check your redirects
- **Use 301 for SEO:** Permanent redirects pass SEO value to new pages
- **Use 200 for SPAs:** Rewrites keep your app's routing intact
- **Force when needed:** The `!` flag overrides existing files
- **Keep it simple:** Most sites only need a few redirect rules

## Troubleshooting

**Redirect not working?**
- Check the order - rules are processed top to bottom
- Make sure the file is named exactly `_redirects` (no extension)
- Verify the file is in your site's root directory

**Wildcard not matching?**
- Wildcards only work at the end of paths
- Use placeholders for more complex restructuring

**Conditional redirect not triggering?**
- Country detection uses IP geolocation
- Language uses Accept-Language headers
- Cookies must match exactly

The `_redirects` system gives you the flexibility to handle complex routing scenarios while keeping your site structure clean and maintainable.
