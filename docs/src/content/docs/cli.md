---
title: Wisp CLI v1.1.0
description: Command-line tool for deploying static sites to the AT Protocol
---

**Deploy static sites to the AT Protocol**

The Wisp CLI is a command-line tool for deploying static websites directly to your AT Protocol account. Host your sites on wisp.place with full ownership and control, backed by the decentralized AT Protocol.

**Jump to:** [Features](#features) · [Downloads](#downloads) · [CI/CD](#cicd-integration) · [Basic Usage](#basic-usage) · [Authentication](#authentication) · [File Processing](#file-processing) · [Incremental Updates](#incremental-updates) · [Limits](#limits) · [Command Reference](#command-reference) · [Development](#development)

## Features

- **Deploy**: Push static sites directly from your terminal
- **Pull**: Download sites from the PDS for development or backup
- **Serve**: Run a local server with real-time firehose updates
- **Private sites**: Upload access-controlled sites and manage share links
- **Authenticate** with app password or OAuth
- **Incremental updates**: Only upload changed files

## Recommended Install

`npm install -g wispctl@latest`

## Downloads

<div class="downloads">

<h2>Download v1.3.1</h2>

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

<a href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-windows.exe" class="download-link" download="">

<span class="platform">Windows (x86_64):</span> wisp-cli-x86_64-windows.exe

</a>

<h3 style="margin-top: 1.5rem; margin-bottom: 0.5rem;">SHA-256 Checksums</h3>

<pre style="font-size: 0.75rem; padding: 1rem;" class="language-bash" tabindex="0"><code class="language-bash">
ed3b5d82291fd955ade565780837844d67eba60869948f1ec1e78fa810f30a70  wisp-cli-aarch64-darwin
11b911d957480731974c6aa6a7ac274c8ec64074a0886bd095596d77dce58196  wisp-cli-x86_64-darwin
4402c7688d7e318b4d62fe132ec9ac67db368b24c01d987d736c7558e3fa2f2c  wisp-cli-darwin-universal
3fc6ce46f7d07b5b55a59d5fc2f648ec446e25fc1e0475f92de51eb0a361eec2  wisp-cli-aarch64-linux
e60bb9025c12dad7a1e4c53da58638737b7bc35c5e560aa3cf913573b2b8eb9f  wisp-cli-x86_64-linux
5372c0ad37f2b925853d1fb1c9d9c85fbd4fbfbc11d58671cd084394e7584bdc  wisp-cli-x86_64-windows.exe
</code></pre>

</div>

note: the tool used to be named wisp-cli and downloadable binaries are kept this way to preseve compatibility with CI

## CI/CD Integration

Deploy automatically on every push using Tangled Spindle:

```yaml
when:
  - event: ['push']
    branch: ['main']
  - event: ['manual']

engine: 'nixery'

dependencies:
  nixpkgs:
    - nodejs
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
        --site "$SITE_NAME"
```

**Note:** Set `WISPCTL_APP_PASSWORD` as a secret in your Tangled Spindle repository settings.
The CLI reads it directly from the environment, keeping the app password out of the process
arguments. Generate an app password from your AT Protocol account settings.

## Basic Usage

### Deploy a Site

```bash
# Download and make executable
curl -O https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-aarch64-darwin
chmod +x wisp-cli-aarch64-darwin

# Deploy your site
wispctl deploy your-handle.bsky.social \
  --path ./dist \
  --site my-site
```

Your site will be available at: `https://sites.wisp.place/your-handle/my-site`

### Domain Management

```bash
# Claim a custom domain
wispctl domain claim your-handle.bsky.social --domain example.com

# Claim a subdomain
wispctl domain claim-subdomain your-handle.bsky.social --subdomain alice

# Check domain status
wispctl domain status your-handle.bsky.social --domain example.com

# Attach a site to a domain
wispctl domain add-site your-handle.bsky.social --domain example.com --site mysite

# Delete a domain or site
wispctl domain delete your-handle.bsky.social --domain example.com
wispctl site delete your-handle.bsky.social --site mysite
```

### List Domains & Sites

```bash
wispctl list domains your-handle.bsky.social
wispctl list sites your-handle.bsky.social
```

### Options

Use an alternate proxy service DID:

```bash
wispctl list domains your-handle.bsky.social --service did:web:example.com
```

### Pull a Site from PDS

Download a site from the PDS to your local machine:

```bash
# Pull a site to a specific directory
wispctl pull your-handle.bsky.social \
  --site my-site \
  --path ./my-site

# Pull to current directory
wispctl pull your-handle.bsky.social \
  --site my-site
```

### Serve a Site Locally with Real-Time Updates

Run a local server that monitors the firehose for real-time updates:

```bash
# Serve on http://localhost:8080 (default)
wispctl serve your-handle.bsky.social \
  --site my-site

# Serve on a custom port
wispctl serve your-handle.bsky.social \
  --site my-site \
  --port 3000

# Enable SPA mode (serve index.html for all routes)
wispctl serve your-handle.bsky.social \
  --site my-site \
  --spa

# Enable directory listing for paths without index files
wispctl serve your-handle.bsky.social \
  --site my-site \
  --directory

# Explicitly expose the server to other machines (use a firewall or reverse proxy)
wispctl serve your-handle.bsky.social \
  --site my-site \
  --host 0.0.0.0
```

Downloads site, serves it, and watches firehose for live updates!

the server binds to loopback (`127.0.0.1`) by default. use `--host` only when you
intend to make it reachable from a network; public exposure should be protected by
an appropriate firewall or reverse proxy.

## Authentication

Credentials are stored once and shared across every directory. Handles are remembered per
directory, so after the first login a bare `wispctl deploy` in that folder just works.

### OAuth (Recommended)

```bash
wispctl login your-handle.bsky.social
```

This opens your browser and stores the session in your OS keychain (macOS Keychain, Windows
Credential Manager, or the Secret Service on Linux), keyed by DID. Running
`wispctl deploy your-handle.bsky.social` from any other directory reuses that stored session
instead of opening the browser again.

If no OS credential store is available, OAuth sessions fall back to a local SQLite file at
`~/.config/wispctl/state.sqlite` and the CLI warns you.

### App Password

For headless environments or CI/CD, use an app password:

```bash
wispctl deploy your-handle.bsky.social \
  --path ./dist \
  --site my-site \
  --password YOUR_APP_PASSWORD
```

To avoid putting the secret in the command line (where it is visible in the process table),
set `WISPCTL_APP_PASSWORD` instead:

```bash
export WISPCTL_APP_PASSWORD=YOUR_APP_PASSWORD
wispctl deploy your-handle.bsky.social --path ./dist --site my-site
```

The environment variable is used whenever a handle is given; with no handle the CLI falls back
to your stored accounts as usual.

You can also save an app password to the keychain so you do not have to supply it each time:

```bash
WISPCTL_APP_PASSWORD=YOUR_APP_PASSWORD wispctl login your-handle.bsky.social
```

App passwords are only ever written to the OS credential store — unlike short-lived OAuth
tokens they are never written to the SQLite fallback. On a machine without a keychain, the
login still works but the password is not saved.

**Generate app passwords** from your AT Protocol account settings.

### Managing Accounts

```bash
# List stored accounts, their credentials, and which directories are linked
wispctl accounts

# Pick the account used in directories with no linked account
wispctl accounts use your-handle.bsky.social

# Unlink the current directory (stored credentials stay put)
wispctl logout

# Forget one account everywhere, including its stored credentials
wispctl logout your-handle.bsky.social

# Forget everything
wispctl logout --all
```

A bare command with no handle resolves in this order: the account linked to the current
directory, then the account chosen with `wispctl accounts use`, then your only stored account
if you have exactly one. With several accounts and no explicit choice, the CLI prompts rather
than guessing which identity to deploy as.

## File Processing

The CLI handles all file processing automatically to ensure reliable storage and delivery. Files are compressed with gzip at level 9 for optimal size reduction, then base64 encoded to bypass PDS content sniffing restrictions. Everything is uploaded as `application/octet-stream` blobs while preserving the original MIME type as metadata. When serving your site, the hosting service automatically decompresses non-HTML/CSS/JS files, ensuring your content is delivered correctly to visitors.

**File Filtering**: The CLI automatically excludes common files like `.git`, `node_modules`, `.env`, and other development artifacts. Customize this with a [`.wispignore` file](/file-filtering).

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
wispctl deploy [OPTIONS] [HANDLE]

Arguments:
  [HANDLE]  Handle (e.g., alice.bsky.social) or DID. Optional once an account is stored.

Options:
  -p, --path <PATH>           Path to site directory [default: .]
  -s, --site <SITE>           Site name (defaults to directory name)
      --password <PASSWORD>   App password for authentication
      --db <PATH>             Account database path [default: ~/.config/wispctl/state.sqlite]
  -h, --help                  Print help
```

### Pull Command

```bash
wispctl pull [OPTIONS] --site <SITE> <INPUT>

Arguments:
  <INPUT>  Handle or DID

Options:
  -s, --site <SITE>           Site name to download
  -p, --path <PATH>           Output directory [default: .]
  -h, --help                  Print help
```

### Serve Command

```bash
wispctl serve [OPTIONS] --site <SITE> <INPUT>

Arguments:
  <INPUT>  Handle or DID

Options:
  -s, --site <SITE>           Site name to serve
  -p, --path <PATH>           Site files directory [default: .]
  -P, --port <PORT>           Port to serve on [default: 8080]
      --host <HOST>           Bind address [default: 127.0.0.1]
      --spa                   Enable SPA mode (serve index.html for all routes)
      --directory             Enable directory listing mode for paths without index files
  -h, --help                  Print help
```

- [place.wisp.fs](/lexicons/place-wisp-fs) - Site manifest lexicon
- [place.wisp.subfs](/lexicons/place-wisp-subfs) - Subtree records for large sites
- [AT Protocol](https://atproto.com) - The decentralized protocol powering Wisp
