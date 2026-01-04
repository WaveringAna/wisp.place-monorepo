# Wisp CLI

A command-line tool for deploying static sites to your AT Protocol repo to be served on [wisp.place](https://wisp.place), an AT indexer to serve such sites.

## Why?

The PDS serves as a way to verfiably, cryptographically prove that you own your site. That it was you (or at least someone who controls your account) who uploaded it. It is also a manifest of each file in the site to ensure file integrity. Keeping hosting seperate ensures that you could move your site across other servers or even serverless solutions to ensure speedy delievery while keeping it backed by an absolute source of truth being the manifest record and the blobs of each file in your repo.

## Features

- Deploy static sites directly to your AT Protocol repo
- Supports both OAuth and app password authentication
- Preserves directory structure and file integrity

## Soon

-- Host sites
-- Manage and delete sites
-- Metrics and logs for self hosting.

## Installation

### From Source

```bash
cargo build --release
```

Check out the build scripts for cross complation using nix-shell.

The binary will be available at `target/release/wisp-cli`.

## Usage

### Commands

The CLI supports three main commands:
- **deploy**: Upload a site to your PDS (default command)
- **pull**: Download a site from a PDS to a local directory
- **serve**: Serve a site locally with real-time firehose updates

### Basic Deployment

Deploy the current directory:

```bash
wisp-cli nekomimi.pet --path . --site my-site
```

Deploy a specific directory:

```bash
wisp-cli alice.bsky.social --path ./dist/ --site my-site
```

Or use the explicit `deploy` subcommand:

```bash
wisp-cli deploy alice.bsky.social --path ./dist/ --site my-site
```

### Pull a Site

Download a site from a PDS to a local directory:

```bash
wisp-cli pull alice.bsky.social --site my-site --path ./downloaded-site
```

This will download all files from the site to the specified directory.

### Serve a Site Locally

Serve a site locally with real-time updates from the firehose:

```bash
wisp-cli serve alice.bsky.social --site my-site --path ./site --port 8080
```

This will:
1. Download the site to the specified path
2. Start a local server on the specified port (default: 8080)
3. Watch the firehose for updates and automatically reload files when changed

### Authentication Methods

#### OAuth (Recommended)

By default, the CLI uses OAuth authentication with a local loopback server:

```bash
wisp-cli alice.bsky.social --path ./my-site --site my-site
```

This will:
1. Open your browser for authentication
2. Save the session to a file (default: `/tmp/wisp-oauth-session.json`)
3. Reuse the session for future deployments

Specify a custom session file location:

```bash
wisp-cli alice.bsky.social --path ./my-site --site my-site --store ~/.wisp-session.json
```

#### App Password

For headless environments or CI/CD, use an app password:

```bash
wisp-cli alice.bsky.social --path ./my-site --site my-site --password YOUR_APP_PASSWORD
```

**Note:** When using `--password`, the `--store` option is ignored.

## Command-Line Options

### Deploy Command

```
wisp-cli [deploy] [OPTIONS] <INPUT>

Arguments:
  <INPUT>  Handle (e.g., alice.bsky.social), DID, or PDS URL

Options:
  -p, --path <PATH>           Path to the directory containing your static site [default: .]
  -s, --site <SITE>           Site name (defaults to directory name)
      --store <STORE>         Path to auth store file (only used with OAuth) [default: /tmp/wisp-oauth-session.json]
      --password <PASSWORD>   App Password for authentication (alternative to OAuth)
      --directory             Enable directory listing mode for paths without index files
      --spa                   Enable SPA mode (serve index.html for all routes)
  -y, --yes                   Skip confirmation prompts (automatically accept warnings)
  -h, --help                  Print help
  -V, --version               Print version
```

### Pull Command

```
wisp-cli pull [OPTIONS] --site <SITE> <INPUT>

Arguments:
  <INPUT>  Handle (e.g., alice.bsky.social) or DID

Options:
  -s, --site <SITE>  Site name (record key)
  -p, --path <PATH>  Output directory for the downloaded site [default: .]
  -h, --help         Print help
```

### Serve Command

```
wisp-cli serve [OPTIONS] --site <SITE> <INPUT>

Arguments:
  <INPUT>  Handle (e.g., alice.bsky.social) or DID

Options:
  -s, --site <SITE>  Site name (record key)
  -p, --path <PATH>  Output directory for the site files [default: .]
  -P, --port <PORT>  Port to serve on [default: 8080]
  -h, --help         Print help
```

## How It Works

1. **Authentication**: Authenticates using OAuth or app password
2. **File Processing**:
   - Recursively walks the directory tree
   - Skips hidden files (starting with `.`)
   - Detects MIME types automatically
   - Compresses files with gzip
   - Base64 encodes compressed content
3. **Upload**:
   - Uploads files as blobs to your PDS
   - Processes up to 5 files concurrently
   - Creates a `place.wisp.fs` record with the site manifest
4. **Deployment**: Site is immediately available at `https://sites.wisp.place/{did}/{site-name}`

## File Processing

All files are automatically:

- **Compressed** with gzip (level 9)
- **Base64 encoded** to bypass PDS content sniffing
- **Uploaded** as `application/octet-stream` blobs
- **Stored** with original MIME type metadata

The hosting service automatically decompresses non HTML/CSS/JS files when serving them.

## Limitations

- **Max file size**: 100MB per file (after compression) (this is a PDS limit, but not enforced by the CLI in case yours is higher)
- **Max file count**: 2000 files 
- **Site name** must follow AT Protocol rkey format rules (alphanumeric, hyphens, underscores)

## Deploy with CI/CD

### GitHub Actions

```yaml
name: Deploy to Wisp
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '25'

      - name: Install dependencies
        run: npm install

      - name: Build site
        run: npm run build

      - name: Download Wisp CLI
        run: |
          curl -L https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli
          chmod +x wisp-cli

      - name: Deploy to Wisp
        env:
          WISP_APP_PASSWORD: ${{ secrets.WISP_APP_PASSWORD }}
        run: |
          ./wisp-cli alice.bsky.social \
            --path ./dist \
            --site my-site \
            --password "$WISP_APP_PASSWORD"
```

### Tangled.org

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

      # regenerate lockfile
      rm package-lock.json bun.lock
      bun install @rolldown/binding-linux-arm64-gnu --save-optional
      bun install

      # build with vite
      bun node_modules/.bin/vite build

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

### Generic Shell Script

```bash
# Use app password from environment variable
wisp-cli alice.bsky.social --path ./dist --site my-site --password "$WISP_APP_PASSWORD"
```

## Output

Upon successful deployment, you'll see:

```
Deployed site 'my-site': at://did:plc:abc123xyz/place.wisp.fs/my-site
Available at: https://sites.wisp.place/did:plc:abc123xyz/my-site
```

### Dependencies

- **jacquard**: AT Protocol client library
- **clap**: Command-line argument parsing
- **tokio**: Async runtime
- **flate2**: Gzip compression
- **base64**: Base64 encoding
- **walkdir**: Directory traversal
- **mime_guess**: MIME type detection

## License

MIT License

## Contributing

Just don't give me entirely claude slop especailly not in the PR description itself. You should be responsible for code you submit and aware of what it even is you're submitting.

## Links

- **Website**: https://wisp.place
- **Main Repository**: https://tangled.org/@nekomimi.pet/wisp.place-monorepo
- **AT Protocol**: https://atproto.com
- **Jacquard Library**: https://tangled.org/@nonbinary.computer/jacquard

## Support

For issues and questions:
- Check the main wisp.place documentation
- Open an issue in the main repository
