import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@public/components/ui/card";
import { Badge } from "@public/components/ui/badge";
import { Download, ExternalLink } from "lucide-react";
import { CodeBlock } from "@public/components/ui/code-block";

const BASE_URL =
  "https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries";

const BINARIES = [
  {
    platform: "macOS (Apple Silicon)",
    filename: "wisp-cli-aarch64-darwin",
    sha256:
      "06544b3a3e27a4b8d7b3a46a39fb7205cf90b3061e19fe533b090facd604f375",
  },
  {
    platform: "macOS (Intel)",
    filename: "wisp-cli-x86_64-darwin",
    sha256:
      "9ec523e3ceef927b37adc52d449dcd9e13ea84fa49b0b77f0d5932c94cfe262e",
  },
  {
    platform: "Linux (ARM64)",
    filename: "wisp-cli-aarch64-linux",
    sha256:
      "42a262668e13dce36173a4096cdc2b22358b805cf192335f84534c7f695d395b",
  },
  {
    platform: "Linux (x86_64)",
    filename: "wisp-cli-x86_64-linux",
    sha256:
      "589ee59f3959ddfbc12fea38d2bcb91701f1362f560ae6fd506bebea3150e2cc",
  },
] as const;

const FEATURES = [
  { label: "Deploy", desc: "Push static sites directly from your terminal" },
  {
    label: "Pull",
    desc: "Download sites from the PDS for development or backup",
  },
  {
    label: "Serve",
    desc: "Run a local server with real-time firehose updates",
  },
  {
    label: "Domains",
    desc: "Claim, manage, and assign custom domains on wisp.place",
  },
] as const;

const LINKS = [
  { label: "CLI Documentation", href: "https://docs.wisp.place/cli" },
  {
    label: "Source Code",
    href: "https://tangled.org/@nekomimi.pet/wisp.place-monorepo/tree/main/cli",
  },
  { label: "Tangled Spindle CI/CD", href: "https://blog.tangled.org/ci" },
] as const;

export function CLITab() {
  return (
    <div className="space-y-4 min-h-[400px]">
      {/* Header + Features */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Wisp CLI</CardTitle>
            <Badge variant="secondary" className="text-xs">
              v1.0.0
            </Badge>
          </div>
          <CardDescription>
            Deploy static sites directly from your terminal
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {FEATURES.map(({ label, desc }) => (
              <li key={label} className="flex items-start gap-3 text-sm">
                <span className="text-muted-foreground mt-0.5 shrink-0 select-none">
                  &gt;
                </span>
                <span className="text-muted-foreground">
                  <strong className="text-foreground">{label}</strong> — {desc}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Downloads */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Download v1.0.0</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {BINARIES.map(({ platform, filename, sha256 }) => (
            <a
              key={filename}
              href={`${BASE_URL}/${filename}`}
              download
              className="flex flex-col gap-1 p-3 rounded-lg border border-border bg-muted/30 hover:bg-muted hover:border-muted-foreground/30 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{platform}</span>
                <Download className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
              </div>
              <span className="font-mono text-[11px] text-muted-foreground break-all leading-relaxed">
                SHA-256: {sha256}
              </span>
            </a>
          ))}
        </CardContent>
      </Card>

      {/* Basic Usage */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basic Usage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm font-medium">Deploy a Site</p>
            <CodeBlock
              code={`./wisp-cli deploy your-handle.bsky.social \\
  --path ./dist \\
  --site my-site

# Available at:
# https://sites.wisp.place/your-handle/my-site`}
              language="bash"
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Pull a Site</p>
            <CodeBlock
              code={`./wisp-cli pull your-handle.bsky.social \\
  --site my-site \\
  --output ./my-site`}
              language="bash"
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Serve with Live Updates</p>
            <CodeBlock
              code={`# Serve on http://localhost:8080 (default)
./wisp-cli serve your-handle.bsky.social --site my-site

# Custom port, SPA mode, or directory listing
./wisp-cli serve your-handle.bsky.social --site my-site --port 3000
./wisp-cli serve your-handle.bsky.social --site my-site --spa
./wisp-cli serve your-handle.bsky.social --site my-site --directory`}
              language="bash"
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Domain Management</p>
            <CodeBlock
              code={`./wisp-cli domain claim your-handle.bsky.social --domain example.com
./wisp-cli domain claim-subdomain your-handle.bsky.social --subdomain alice
./wisp-cli domain status your-handle.bsky.social --domain example.com
./wisp-cli domain add-site your-handle.bsky.social --domain example.com --site mysite
./wisp-cli domain delete your-handle.bsky.social --domain example.com
./wisp-cli site delete your-handle.bsky.social --site mysite`}
              language="bash"
            />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">List Domains & Sites</p>
            <CodeBlock
              code={`./wisp-cli list domains your-handle.bsky.social
./wisp-cli list sites your-handle.bsky.social`}
              language="bash"
            />
          </div>
        </CardContent>
      </Card>

      {/* CI/CD */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CI/CD with Tangled Spindle</CardTitle>
          <CardDescription>
            Deploy automatically on every push using{" "}
            <a
              href="https://blog.tangled.org/ci"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              Tangled Spindle
            </a>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Simple Deploy</p>
              <Badge variant="secondary" className="text-xs">
                Copy Files
              </Badge>
            </div>
            <CodeBlock
              code={`steps:
  - name: deploy to wisp
    command: |
      curl https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli
      ./wisp-cli deploy "$WISP_HANDLE" \\
        --path "$SITE_PATH" \\
        --site "$SITE_NAME" \\
        --password "$WISP_APP_PASSWORD"`}
              language="yaml"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">React / Vite Build & Deploy</p>
              <Badge variant="secondary" className="text-xs">
                Full Build
              </Badge>
            </div>
            <CodeBlock
              code={`when:
  - event: ['push']
    branch: ['main']
  - event: ['manual']

engine: 'nixery'

clone:
  skip: false
  depth: 1

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
      bun install --frozen-lockfile
      bun node_modules/.bin/vite build

  - name: deploy to wisp
    command: |
      curl https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli
      ./wisp-cli deploy "$WISP_HANDLE" \\
        --path "$SITE_PATH" \\
        --site "$SITE_NAME" \\
        --password "$WISP_APP_PASSWORD"`}
              language="yaml"
            />
          </div>

          <div className="p-3 bg-muted/30 rounded-lg border-l-4 border-accent text-xs text-muted-foreground">
            <strong className="text-foreground">Note:</strong> Set{" "}
            <code className="px-1 py-0.5 bg-background rounded">
              WISP_APP_PASSWORD
            </code>{" "}
            as a secret in your Tangled Spindle repository settings.
          </div>
        </CardContent>
      </Card>

      {/* Learn More */}
      <Card>
        <CardContent className="pt-6 space-y-1.5">
          {LINKS.map(({ label, href }) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/30 hover:bg-muted transition-colors"
            >
              <span className="text-sm">{label}</span>
              <ExternalLink className="w-4 h-4 text-muted-foreground" />
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
