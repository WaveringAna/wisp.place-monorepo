---
title: Blob Reuse & Framework Caveats
description: How Wisp's blob reuse works and how to avoid breaking it with framework defaults
---

Wisp uses content-addressed blob storage — when you deploy, blobs that haven't changed are skipped. This means only new or modified files get uploaded, making subsequent deployments fast and cheap.

However, some frameworks include build-time hashes or version identifiers that change on every build, which causes all dependent chunks to be re-uploaded even when their actual content hasn't changed.

## SvelteKit Version Hash

SvelteKit includes a unique "version hash" in its build output by default. This hash changes the hash of the main Svelte bundle and every chunk that depends on it. Since Wisp detects changes by blob hash, this forces a full re-upload of all JavaScript chunks on every deploy.

For small sites this doesn't matter much, but for large apps with many chunks (e.g., code editors, pastebins) you can hit deployment rate limits because you're re-uploading hundreds of unchanged files on every deploy.

### Fix

Set a fixed version name in `svelte.config.js`:

```js
/** @satisfies {import('@sveltejs/kit').Config} */
const config = {
    kit: {
        version: {
            name: '1'
        }
    }
};

export default config;
```

This keeps the version hash stable across builds. Only chunks whose actual content changed will be re-uploaded.

> **Note:** If you rely on SvelteKit's version detection for cache busting (e.g., detecting when a new version of your app has been deployed), a fixed version name will disable that behavior. For most static sites on Wisp this is fine since cache invalidation is handled by the platform.
