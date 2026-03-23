---
title: Wisp CLI
description: Command-line tool for deploying static sites to the AT Protocol
---

`wispctl` deploys static sites to your AT Protocol account from the terminal. Supports incremental updates, OAuth and app password auth, and a local dev server with live firehose updates.

## Installation

```bash
npm install -g wispctl
```

Then use `wispctl` anywhere:

```bash
wispctl deploy your-handle.bsky.social --path ./dist --site my-site
```

## Quick Deploy

No install needed — use `npm create wisp` to deploy directly:

```bash
npm create wisp your-handle.bsky.social --path ./dist --site my-site
```

Or with `npx`:

```bash
npx wispctl deploy your-handle.bsky.social --path ./dist --site my-site
```

## Deploying a Site

```bash
wispctl deploy your-handle.bsky.social --path ./dist --site my-site
```

Your site will be at `https://sites.wisp.place/your-handle/my-site`.

The CLI tracks files by content hash (CID), so subsequent deploys only upload what actually changed. First deploy uploads everything; after that, deploys complete in seconds when only a few files differ.

## Authentication

OAuth is the default — it opens your browser and saves a session to `/tmp/wisp-oauth-session.json`. For CI/CD or headless environments, use an app password instead:

```bash
wispctl deploy your-handle.bsky.social \
  --path ./dist \
  --site my-site \
  --password YOUR_APP_PASSWORD
```

Generate app passwords from your AT Protocol account settings. Don't use your main password.

## Domain Management

```bash
# Claim a wisp.place subdomain
wispctl domain claim-subdomain your-handle.bsky.social --subdomain alice

# Claim a custom domain
wispctl domain claim your-handle.bsky.social --domain example.com

# Check domain status
wispctl domain status your-handle.bsky.social --domain example.com

# Attach a site to a domain
wispctl domain add-site your-handle.bsky.social --domain example.com --site mysite

# Delete a domain or site
wispctl domain delete your-handle.bsky.social --domain example.com
wispctl site delete your-handle.bsky.social --site mysite
```

```bash
wispctl list domains your-handle.bsky.social
wispctl list sites your-handle.bsky.social
```

## Pulling a Site

Download a site from the PDS to your local machine:

```bash
wispctl pull your-handle.bsky.social --site my-site --path ./my-site
```

## Local Dev Server

Serve a site locally with real-time updates from the firehose:

```bash
wispctl serve your-handle.bsky.social --site my-site
wispctl serve your-handle.bsky.social --site my-site --port 3000
wispctl serve your-handle.bsky.social --site my-site --spa        # serve index.html for all routes
wispctl serve your-handle.bsky.social --site my-site --directory  # directory listing
```

## CI/CD

Deploy automatically on every push using Tangled Spindle:

```yaml
when:
  - event: ['push']
    branch: ['main']
  - event: ['manual']

engine: 'nixery'

dependencies:
  nixpkgs:
    - coreutils
    - curl
    - glibc
  github:NixOS/nixpkgs/nixpkgs-unstable:
    - bun

environment:
  SITE_PATH: 'dist'
  SITE_NAME: 'my-site'
  WISP_HANDLE: 'your-handle.bsky.social'

steps:
  - name: build site
    command: |
      export PATH="$HOME/.nix-profile/bin:$PATH"
      bun install
      bun run build

  - name: deploy to wisp
    command: |
      curl -fsSL https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wispctl
      chmod +x wispctl
      ./wispctl deploy \
        "$WISP_HANDLE" \
        --path "$SITE_PATH" \
        --site "$SITE_NAME" \
        --password "$WISP_APP_PASSWORD"
```

Set `WISP_APP_PASSWORD` as a secret in your Tangled Spindle repository settings.

## File Processing

Files are gzip-compressed at level 9 and uploaded as `application/octet-stream` blobs with the original MIME type stored in the manifest. They may also be base64-encoded to bypass content sniffing on legacy reference PDS. The hosting service handles decompression transparently.

Common build artifacts like `.git`, `node_modules`, and `.env` are excluded automatically. Customize this with a [`.wispignore` file](/file-filtering).

## Limits

- Max file size: 100 MB (after compression)
- Max total size: 300 MB per site
- Max files: 1,000 per site
- Site name: alphanumeric, hyphens, underscores (AT Protocol rkey format)

## Command Reference

### deploy

```
wispctl deploy [OPTIONS] <INPUT>

Arguments:
  <INPUT>  Handle (e.g., alice.bsky.social), DID, or PDS URL

Options:
  -p, --path <PATH>           Path to site directory [default: .]
  -s, --site <SITE>           Site name (defaults to directory name)
      --store <STORE>         OAuth session file [default: /tmp/wisp-oauth-session.json]
      --password <PASSWORD>   App password
```

### pull

```
wispctl pull [OPTIONS] --site <SITE> <INPUT>

Arguments:
  <INPUT>  Handle or DID

Options:
  -s, --site <SITE>   Site name to download
  -p, --path <PATH>   Output directory [default: .]
```

### serve

```
wispctl serve [OPTIONS] --site <SITE> <INPUT>

Arguments:
  <INPUT>  Handle or DID

Options:
  -s, --site <SITE>    Site name
  -p, --path <PATH>    Site files directory [default: .]
  -P, --port <PORT>    Port [default: 8080]
      --spa            Serve index.html for all routes
      --directory      Directory listing for paths without index files
```

## Binary Downloads

Pre-built binaries are available if you can't use npm.

<div class="downloads">

<h2>Download v1.0.0</h2>

<a href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-aarch64-darwin" class="download-link" download="">

<span class="platform">macOS (Apple Silicon):</span> wisp-cli-aarch64-darwin

</a>

<a href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-darwin" class="download-link" download="">

<span class="platform">macOS (Intel):</span> wisp-cli-x86_64-darwin

</a>

<a href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-aarch64-linux" class="download-link" download="">

<span class="platform">Linux (ARM64):</span> wisp-cli-aarch64-linux

</a>

<a href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux" class="download-link" download="">

<span class="platform">Linux (x86_64):</span> wisp-cli-x86_64-linux

</a>

<h3 style="margin-top: 1.5rem; margin-bottom: 0.5rem;">SHA-256 Checksums</h3>

<pre style="font-size: 0.75rem; padding: 1rem;" class="language-bash" tabindex="0"><code class="language-bash">
06544b3a3e27a4b8d7b3a46a39fb7205cf90b3061e19fe533b090facd604f375  wisp-cli-aarch64-darwin
9ec523e3ceef927b37adc52d449dcd9e13ea84fa49b0b77f0d5932c94cfe262e  wisp-cli-x86_64-darwin
42a262668e13dce36173a4096cdc2b22358b805cf192335f84534c7f695d395b  wisp-cli-aarch64-linux
589ee59f3959ddfbc12fea38d2bcb91701f1362f560ae6fd506bebea3150e2cc  wisp-cli-x86_64-linux
</code></pre>

</div>

## Building from Source

The CLI is written in TypeScript and supports both Node.js and Bun runtimes. Run directly with Bun during development, or build a Node.js-compatible bundle for distribution.

```bash
git clone https://tangled.org/@nekomimi.pet/wisp.place-monorepo
cd cli
bun install

# Run directly with Bun
bun run index.ts

# Build a Node.js bundle (outputs to dist/)
bun run build
node dist/index.js
```
