# wispctl CLI

Run from the `cli/` directory:

```bash
bun run index.ts --help
```

## Install (pre-built binary)

```bash
# macOS (Apple Silicon)
curl -O https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-aarch64-darwin
chmod +x wisp-cli-aarch64-darwin

# macOS (Intel)
curl -O https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-darwin
chmod +x wisp-cli-x86_64-darwin

# macOS (Universal)
curl -O https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-darwin-universal
chmod +x wisp-cli-darwin-universal

# Linux (x86_64)
curl -O https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux
chmod +x wisp-cli-x86_64-linux

# Linux (ARM64)
curl -O https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-aarch64-linux
chmod +x wisp-cli-aarch64-linux
```

## Deploy a site

```bash
bun run index.ts deploy alice.bsky.social --path . --site my-blog
bun run index.ts alice.bsky.social --path . --site my-blog
```

## Pull a site from PDS

Download a site from the PDS to your local machine (uses OAuth authentication):

```bash
# Pull to a specific directory
bun run index.ts pull alice.bsky.social --site my-blog --output ./my-blog

# Pull to current directory
bun run index.ts pull alice.bsky.social --site my-blog
```

## Serve a site locally

Run a local server that monitors the firehose for real-time updates (uses OAuth authentication):

```bash
# Serve on http://localhost:8080 (default)
bun run index.ts serve alice.bsky.social --site my-blog

# Serve on a custom port
bun run index.ts serve alice.bsky.social --site my-blog --port 3000

# Enable SPA mode (serve index.html for all routes)
bun run index.ts serve alice.bsky.social --site my-blog --spa

# Enable directory listing for paths without index files
bun run index.ts serve alice.bsky.social --site my-blog --directory
```

## List domains / sites

```bash
bun run index.ts list domains alice.bsky.social
bun run index.ts list sites alice.bsky.social
```

## Domain CRUD

```bash
bun run index.ts domain claim alice.bsky.social --domain example.com
bun run index.ts domain claim-subdomain alice.bsky.social --subdomain alice
bun run index.ts domain status alice.bsky.social --domain example.com
bun run index.ts domain add-site alice.bsky.social --domain example.com --site mysite
bun run index.ts domain delete alice.bsky.social --domain example.com
bun run index.ts site delete alice.bsky.social --site mysite
```

## Options

Use an alternate proxy service DID:

```bash
bun run index.ts list domains alice.bsky.social --service did:web:regents-macbook-air.west-major.ts.net
```

## OAuth note

- CLI requests `rpc:<nsid>?aud=*` scopes for Wisp XRPC methods.
- `--service did:...` controls proxy target (`atproto-proxy`), not scope audience (scoping audience couldnt work for me idk why).
