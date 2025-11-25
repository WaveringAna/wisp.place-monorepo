---
title: Wisp CLI 0.2.0 (alpha)
description: Command-line tool for deploying static sites to the AT Protocol
---

**Deploy static sites to the AT Protocol**

The Wisp CLI is a command-line tool for deploying static websites directly to your AT Protocol account. Host your sites on wisp.place with full ownership and control, backed by the decentralized AT Protocol.

## Features

- **Deploy**: Push static sites directly from your terminal
- **Pull**: Download sites from the PDS for development or backup
- **Serve**: Run a local server with real-time firehose updates
- **Authenticate** with app password or OAuth
- **Incremental updates**: Only upload changed files

## Downloads

<div class="downloads">

<h2>Download v0.3.0</h2>

<a href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-aarch64-darwin" class="download-link" download="">

<span class="platform">macOS (Apple Silicon):</span> wisp-cli-aarch64-darwin

</a>

<a href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-aarch64-linux" class="download-link" download="">

<span class="platform">Linux (ARM64):</span> wisp-cli-aarch64-linux

</a>

<a href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux" class="download-link" download="">

<span class="platform">Linux (x86_64):</span> wisp-cli-x86_64-linux

</a>

<a href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-windows.exe" class="download-link" download="">

<span class="platform">Windows (x86_64):</span> wisp-cli-x86_64-windows.exe

</a>

<h3 style="margin-top: 1.5rem; margin-bottom: 0.5rem;">SHA-1 Checksums</h3>

<pre style="font-size: 0.75rem; padding: 1rem;" class="language-bash" tabindex="0"><code class="language-bash">
9281454860f2eb07b39b80f7a9cc8e9bdcff491b  wisp-cli-aarch64-darwin

d460863150c4c162b7e7e3801a67746da3aaf9d9  wisp-cli-aarch64-linux

94968abed20422df826b78c38cb506dd4b1b5885  wisp-cli-x86_64-linux

45293e47da38b97ef35258a08cb2682eee64a659  wisp-cli-x86_64-windows.exe
</code></pre>

</div>

## CI/CD Integration

Deploy automatically on every push using Tangled Spindle:

```yaml
when:
  - event: ['push']
    branch: ['main']
  - event: ['manual']

engine: 'nixery'

clone:
  skip: false
  depth: 1
  submodules: false

dependencies:
  nixpkgs:
    - nodejs
    - coreutils
    - curl
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
      
      # you may need to regenerate the lockfile due to nixery being weird
      # rm package-lock.json bun.lock
      bun install

      bun run build

  - name: deploy to wisp
    command: |
      # Download Wisp CLI
      curl https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli

      # Deploy to Wisp
      ./wisp-cli \
        "$WISP_HANDLE" \
        --path "$SITE_PATH" \
        --site "$SITE_NAME" \
        --password "$WISP_APP_PASSWORD"
```

**Note:** Set `WISP_APP_PASSWORD` as a secret in your Tangled Spindle repository settings. Generate an app password from your AT Protocol account settings.

## Basic Usage

### Deploy a Site

```bash
# Download and make executable
curl -O https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-macos-arm64
chmod +x wisp-cli-macos-arm64

# Deploy your site
./wisp-cli-macos-arm64 deploy your-handle.bsky.social \
  --path ./dist \
  --site my-site
```

Your site will be available at: `https://sites.wisp.place/your-handle/my-site`

### Pull a Site from PDS

Download a site from the PDS to your local machine:

```bash
# Pull a site to a specific directory
wisp-cli pull your-handle.bsky.social \
  --site my-site \
  --output ./my-site

# Pull to current directory
wisp-cli pull your-handle.bsky.social \
  --site my-site
```

### Serve a Site Locally with Real-Time Updates

Run a local server that monitors the firehose for real-time updates:

```bash
# Serve on http://localhost:8080 (default)
wisp-cli serve your-handle.bsky.social \
  --site my-site

# Serve on a custom port
wisp-cli serve your-handle.bsky.social \
  --site my-site \
  --port 3000
```

Downloads site, serves it, and watches firehose for live updates!

## Authentication

### OAuth (Recommended)

The CLI uses OAuth by default, opening your browser for secure authentication:

```bash
wisp-cli deploy your-handle.bsky.social --path ./dist --site my-site
```

This creates a session stored locally (default: `/tmp/wisp-oauth-session.json`).

### App Password

For headless environments or CI/CD, use an app password:

```bash
wisp-cli deploy your-handle.bsky.social \
  --path ./dist \
  --site my-site \
  --password YOUR_APP_PASSWORD
```

**Generate app passwords** from your AT Protocol account settings.

## File Processing

The CLI handles all file processing automatically to ensure reliable storage and delivery. Files are compressed with gzip at level 9 for optimal size reduction, then base64 encoded to bypass PDS content sniffing restrictions. Everything is uploaded as `application/octet-stream` blobs while preserving the original MIME type as metadata. When serving your site, the hosting service automatically decompresses non-HTML/CSS/JS files, ensuring your content is delivered correctly to visitors.

## Incremental Updates

The CLI tracks file changes using CID-based content addressing to minimize upload times and bandwidth usage. On your first deploy, all files are uploaded to establish the initial site. For subsequent deploys, the CLI compares content-addressed CIDs to detect which files have actually changed, uploading only those that differ from the previous version. This makes fast iterations possible even for large sites, with deploys completing in seconds when only a few files have changed.

## Limits

- **Max file size**: 100MB per file (after compression)
- **Max total size**: 300MB per site
- **Max files**: 1000 files per site
- **Site name**: Must follow AT Protocol rkey format (alphanumeric, hyphens, underscores)

## Command Reference

### Deploy Command

```bash
wisp-cli deploy [OPTIONS] <INPUT>

Arguments:
  <INPUT>  Handle (e.g., alice.bsky.social), DID, or PDS URL

Options:
  -p, --path <PATH>           Path to site directory [default: .]
  -s, --site <SITE>           Site name (defaults to directory name)
      --store <STORE>         OAuth session file path [default: /tmp/wisp-oauth-session.json]
      --password <PASSWORD>   App password for authentication
  -h, --help                  Print help
```

### Pull Command

```bash
wisp-cli pull [OPTIONS] <INPUT>

Arguments:
  <INPUT>  Handle or DID

Options:
  -s, --site <SITE>           Site name to download
  -o, --output <OUTPUT>       Output directory [default: .]
  -h, --help                  Print help
```

### Serve Command

```bash
wisp-cli serve [OPTIONS] <INPUT>

Arguments:
  <INPUT>  Handle or DID

Options:
  -s, --site <SITE>           Site name to serve
  -o, --output <OUTPUT>       Site files directory [default: .]
  -p, --port <PORT>           Port to serve on [default: 8080]
  -h, --help                  Print help
```

## Development

The CLI is written in Rust using the Jacquard AT Protocol library. To build from source:

```bash
git clone https://tangled.org/@nekomimi.pet/wisp.place-monorepo
cd cli
cargo build --release
```

Built binaries are available in `target/release/`.

## Related

- [place.wisp.fs](/lexicons/place-wisp-fs) - Site manifest lexicon
- [place.wisp.subfs](/lexicons/place-wisp-subfs) - Subtree records for large sites
- [AT Protocol](https://atproto.com) - The decentralized protocol powering Wisp
