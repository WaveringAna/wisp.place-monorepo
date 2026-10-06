---
title: Wisp CLI
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

## Install

With npm (or bun, pnpm, yarn). The package ships a native binary for your platform, and nothing is
downloaded at install time:

```bash
npm install -g wispctl
# or run it without installing
npx wispctl deploy your-handle.bsky.social --path ./dist --site my-site
```

With cargo, compiling from source:

```bash
cargo install --locked --git https://tangled.org/nekomimi.pet/wisp.place-monorepo wispctl
```

Or download a binary directly:

## Downloads

<div class="downloads">

<h2>Download v2.1.0</h2>

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
30218d511de9ccefb4933b51f259a6dab1b5ee991d2f7fb72ef90620ac08c2f7  wisp-cli-aarch64-darwin
183f5ce0719638f26ec61d17f0bfbbe092d1da07dbd691d0b545aace9fc75e5b  wisp-cli-aarch64-linux
b1a272117d94f47b6e2517b8b5270e2904f22086ba8b8f3cf4cc7192a029ab6d  wisp-cli-darwin-universal
5b3eb41f698ec912d4721aeed05f2478a7feed1d1196cbcea8af1d0eeef0d500  wisp-cli-x86_64-darwin
3122cb4b618195c62f8742b05a94f27f6bb0ab6dcf97b7905bf01107b0b8c427  wisp-cli-x86_64-linux
f20090172b8f931305d608fd40fdec76960296c741889c7f969f895350af30e6  wisp-cli-x86_64-windows.exe
</code></pre>

</div>

The downloads are native builds with no runtime to install. The Linux ones are statically linked, so
they run on any distribution, including Alpine, busybox and nixery images.

note: the tool used to be named wisp-cli and downloadable binaries are kept this way to preserve compatibility with CI

### Upgrading from 1.x binaries

Deploy flags, exit codes and the records a deploy writes are unchanged, so existing CI keeps working.
A few things a script might notice:

- Progress and status lines (`✓ Deployed successfully!` and friends) go to stderr. stdout carries only
  results: the `URI:`/`URL:` lines after a deploy, `--json` output, listings and `--version`.
- `--version` prints a 2.x version.
- Without a terminal, a missing `--site` or `--path` is an error (exit 1) instead of a silent no-op.
- OAuth sessions saved by 1.x can't be reused. Run `wispctl login` once; app passwords saved by 1.x
  still work.
- Certificates: the system store is used, falling back to Mozilla's roots on Linux images that ship none.
  `SSL_CERT_FILE` points at a custom bundle, and `NODE_EXTRA_CA_CERTS` is still honoured.

## CI/CD Integration

Deploy on every push to `main` with Tangled Spindle. Save as `.tangled/workflows/deploy.yml`:

```yaml
when:
  - event: ["push"]
    branch: ["main"]
  - event: ["manual"]

engine: microvm
image: nixos

dependencies:
  - nodejs

environment:
  WISP_HANDLE: "your-handle.bsky.social"
  SITE_NAME: "my-site"
  SITE_PATH: "./dist"

steps:
  - name: build
    command: |
      npm ci
      npm run build

  - name: deploy
    command: |
      npm install --global --prefix "$HOME/.local" wispctl@2.1.0
      export PATH="$HOME/.local/bin:$PATH"
      wispctl deploy "$WISP_HANDLE" --path "$SITE_PATH" --site "$SITE_NAME" --yes
```

Add an app password as the secret `WISPCTL_APP_PASSWORD` in the repository's spindle settings on Tangled.
The CLI reads it from the environment, so it never appears in the process arguments. `wispctl` is
installed under `$HOME/.local` because the Nix store is read-only.

For a live preview of every pull request, with a comment linking to it, see
[Preview deploys](/guides/preview-deploys/). `wispctl preview enable <handle> --repo <name> --claim <label>`
creates the webhook that wakes the preview bot; `wispctl preview disable <handle> --repo <name>` removes it.
In the pull request's pipeline, `wispctl preview deploy --path ./dist` deploys the preview, taking the account,
repo, commit and subdomain from the spindle and that webhook.

## Basic Usage

### Deploy a Site

```bash
npm install -g wispctl

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
  --directory-listing

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

The CLI handles all file processing automatically to ensure reliable storage and delivery. Text files (HTML, CSS, JS, JSON, SVG and the like) and uncompressed audio are compressed with gzip at level 9 (`--force-gzip` compresses everything); if the PDS rejects the manifest, the deploy retries once with text files base64 encoded to get past content sniffing. Everything is uploaded as `application/octet-stream` blobs while preserving the original MIME type as metadata. When serving your site, the hosting service automatically decompresses non-HTML/CSS/JS files, ensuring your content is delivered correctly to visitors.

**File Filtering**: The CLI automatically excludes common files like `.git`, `node_modules`, `.env`, and other development artifacts. Customize this with a [`.wispignore` file](/file-filtering).

## Incremental Updates

The CLI tracks file changes using CID-based content addressing to minimize upload times and bandwidth usage. On your first deploy, all files are uploaded to establish the initial site. For subsequent deploys, the CLI compares content-addressed CIDs to detect which files have actually changed, uploading only those that differ from the previous version. This makes fast iterations possible even for large sites, with deploys completing in seconds when only a few files have changed.

## Limits

- **Max file size**: 200MB per file (after compression)
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
  -p, --path <path>          Directory to deploy (prompted for when omitted)
  -s, --site <name>          Site name (prompted for when omitted)
      --directory            Enable directory listing
      --spa                  Enable SPA mode (serve index.html for all routes)
  -c, --concurrency <n>      Number of concurrent uploads (backs off to 2 on rate limit) [default: 3]
      --force-gzip           Force gzip compression for all files regardless of type
      --password <password>  App password for headless authentication (or set WISPCTL_APP_PASSWORD)
      --db <path>            Account database path [default: ~/.config/wispctl/state.sqlite]
  -y, --yes                  Skip confirmation prompts
  -q, --quiet                Suppress progress output (or set WISPCTL_NO_PROGRESS=1)
  -h, --help                 Print help
```

### Pull Command

```bash
wispctl pull [OPTIONS] --site <name> <HANDLE>

Arguments:
  <HANDLE>  Handle or DID

Options:
  -s, --site <name>  Site name to download
  -p, --path <path>  Output directory [default: .]
  -q, --quiet        Suppress progress output
  -h, --help         Print help
```

### Serve Command

```bash
wispctl serve [OPTIONS] --site <name> <HANDLE>

Arguments:
  <HANDLE>  Handle or DID

Options:
  -s, --site <name>        Site name to serve
  -p, --path <path>        Local directory to cache the site [default: .wisp-serve]
  -P, --port <port>        Port to serve on [default: 8080]
      --host <host>        Bind address [default: 127.0.0.1]
      --spa [<file>]       Enable SPA mode (serve <file> for unmatched routes, default index.html)
      --directory-listing  Enable directory listing for paths without index files
  -q, --quiet              Suppress progress output
  -h, --help               Print help
```

- [place.wisp.fs](/lexicons/place-wisp-fs) - Site manifest lexicon
- [place.wisp.subfs](/lexicons/place-wisp-subfs) - Subtree records for large sites
- [AT Protocol](https://atproto.com) - The decentralized protocol powering Wisp
