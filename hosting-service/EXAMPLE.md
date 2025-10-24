# HTML Path Rewriting Example

This document demonstrates how HTML path rewriting works when serving sites via the `/s/:identifier/:site/*` route.

## Problem

When you create a static site with absolute paths like `/style.css` or `/images/logo.png`, these paths work fine when served from the root domain. However, when served from a subdirectory like `/s/alice.bsky.social/mysite/`, these absolute paths break because they resolve to the server root instead of the site root.

## Solution

The hosting service automatically rewrites absolute paths in HTML files to work correctly in the subdirectory context.

## Example

**Original HTML file (index.html):**
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>My Site</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="icon" href="/favicon.ico">
  <script src="/app.js"></script>
</head>
<body>
  <header>
    <img src="/images/logo.png" alt="Logo">
    <nav>
      <a href="/">Home</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
    </nav>
  </header>

  <main>
    <h1>Welcome</h1>
    <img src="/images/hero.jpg"
         srcset="/images/hero.jpg 1x, /images/hero@2x.jpg 2x"
         alt="Hero">

    <form action="/submit" method="post">
      <input type="text" name="email">
      <button>Submit</button>
    </form>
  </main>

  <footer>
    <a href="https://example.com">External Link</a>
    <a href="#top">Back to Top</a>
  </footer>
</body>
</html>
```

**When accessed via `/s/alice.bsky.social/mysite/`, the HTML is rewritten to:**
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>My Site</title>
  <link rel="stylesheet" href="/s/alice.bsky.social/mysite/style.css">
  <link rel="icon" href="/s/alice.bsky.social/mysite/favicon.ico">
  <script src="/s/alice.bsky.social/mysite/app.js"></script>
</head>
<body>
  <header>
    <img src="/s/alice.bsky.social/mysite/images/logo.png" alt="Logo">
    <nav>
      <a href="/s/alice.bsky.social/mysite/">Home</a>
      <a href="/s/alice.bsky.social/mysite/about">About</a>
      <a href="/s/alice.bsky.social/mysite/contact">Contact</a>
    </nav>
  </header>

  <main>
    <h1>Welcome</h1>
    <img src="/s/alice.bsky.social/mysite/images/hero.jpg"
         srcset="/s/alice.bsky.social/mysite/images/hero.jpg 1x, /s/alice.bsky.social/mysite/images/hero@2x.jpg 2x"
         alt="Hero">

    <form action="/s/alice.bsky.social/mysite/submit" method="post">
      <input type="text" name="email">
      <button>Submit</button>
    </form>
  </main>

  <footer>
    <a href="https://example.com">External Link</a>
    <a href="#top">Back to Top</a>
  </footer>
</body>
</html>
```

## What's Preserved

Notice that:
- ✅ Absolute paths are rewritten: `/style.css` → `/s/alice.bsky.social/mysite/style.css`
- ✅ External URLs are preserved: `https://example.com` stays the same
- ✅ Anchors are preserved: `#top` stays the same
- ✅ The rewriting is safe and won't break your site

## Supported Attributes

The rewriter handles these HTML attributes:
- `src` - images, scripts, iframes, videos, audio
- `href` - links, stylesheets
- `action` - forms
- `data` - objects
- `poster` - video posters
- `srcset` - responsive images

## Testing Your Site

To test if your site works with path rewriting:

1. Upload your site to your PDS as a `place.wisp.fs` record
2. Access it via: `https://hosting.wisp.place/s/YOUR_HANDLE/SITE_NAME/`
3. Check that all resources load correctly

If you're using relative paths already (like `./style.css` or `../images/logo.png`), they'll work without any rewriting.
