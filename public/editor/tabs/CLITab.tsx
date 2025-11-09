import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle
} from '@public/components/ui/card'
import { Badge } from '@public/components/ui/badge'
import { ExternalLink } from 'lucide-react'
import { CodeBlock } from '@public/components/ui/code-block'

export function CLITab() {
	return (
		<div className="space-y-4 min-h-[400px]">
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2 mb-2">
						<CardTitle>Wisp CLI Tool</CardTitle>
						<Badge variant="secondary" className="text-xs">v0.1.0</Badge>
						<Badge variant="outline" className="text-xs">Alpha</Badge>
					</div>
					<CardDescription>
						Deploy static sites directly from your terminal
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="prose prose-sm max-w-none dark:prose-invert">
						<p className="text-sm text-muted-foreground">
							The Wisp CLI is a command-line tool for deploying static websites directly to your AT Protocol account.
							Authenticate with app password or OAuth and deploy from CI/CD pipelines.
						</p>
					</div>

					<div className="space-y-3">
						<h3 className="text-sm font-semibold">Download CLI</h3>
						<div className="grid gap-2">
							<div className="p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border">
								<a
									href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-macos-arm64"
									target="_blank"
									rel="noopener noreferrer"
									className="flex items-center justify-between mb-2"
								>
									<span className="font-mono text-sm">macOS (Apple Silicon)</span>
									<ExternalLink className="w-4 h-4 text-muted-foreground" />
								</a>
								<div className="text-xs text-muted-foreground">
									<span className="font-mono">SHA256: 637e325d9668ca745e01493d80dfc72447ef0a889b313e28913ca65c94c7aaae</span>
								</div>
							</div>
							<div className="p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border">
								<a
									href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-aarch64-linux"
									target="_blank"
									rel="noopener noreferrer"
									className="flex items-center justify-between mb-2"
								>
									<span className="font-mono text-sm">Linux (ARM64)</span>
									<ExternalLink className="w-4 h-4 text-muted-foreground" />
								</a>
								<div className="text-xs text-muted-foreground">
									<span className="font-mono">SHA256: 01561656b64826f95b39f13c65c97da8bcc63ecd9f4d7e4e369c8ba8c903c22a</span>
								</div>
							</div>
							<div className="p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border">
								<a
									href="https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux"
									target="_blank"
									rel="noopener noreferrer"
									className="flex items-center justify-between mb-2"
								>
									<span className="font-mono text-sm">Linux (x86_64)</span>
									<ExternalLink className="w-4 h-4 text-muted-foreground" />
								</a>
								<div className="text-xs text-muted-foreground">
									<span className="font-mono">SHA256: 1ff485b9bcf89bc5721a862863c4843cf4530cbcd2489cf200cb24a44f7865a2</span>
								</div>
							</div>
						</div>
					</div>

					<div className="space-y-3">
						<h3 className="text-sm font-semibold">Basic Usage</h3>
						<CodeBlock
							code={`# Download and make executable
curl -O https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-macos-arm64
chmod +x wisp-cli-macos-arm64

# Deploy your site (will use OAuth)
./wisp-cli-macos-arm64 your-handle.bsky.social \\
  --path ./dist \\
  --site my-site

# Your site will be available at:
# https://sites.wisp.place/your-handle/my-site`}
							language="bash"
						/>
					</div>

					<div className="space-y-3">
						<h3 className="text-sm font-semibold">CI/CD with Tangled Spindle</h3>
						<p className="text-xs text-muted-foreground">
							Deploy automatically on every push using{' '}
							<a
								href="https://blog.tangled.org/ci"
								target="_blank"
								rel="noopener noreferrer"
								className="text-accent hover:underline"
							>
								Tangled Spindle
							</a>
						</p>

						<div className="space-y-4">
							<div>
								<h4 className="text-xs font-semibold mb-2 flex items-center gap-2">
									<span>Example 1: Simple Asset Publishing</span>
									<Badge variant="secondary" className="text-xs">Copy Files</Badge>
								</h4>
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
    - coreutils
    - curl

environment:
  SITE_PATH: '.'  # Copy entire repo
  SITE_NAME: 'myWebbedSite'
  WISP_HANDLE: 'your-handle.bsky.social'

steps:
  - name: deploy assets to wisp
    command: |
      # Download Wisp CLI
      curl https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli

      # Deploy to Wisp
      ./wisp-cli \\
        "$WISP_HANDLE" \\
        --path "$SITE_PATH" \\
        --site "$SITE_NAME" \\
        --password "$WISP_APP_PASSWORD"

      # Output
      #Deployed site 'myWebbedSite': at://did:plc:ttdrpj45ibqunmfhdsb4zdwq/place.wisp.fs/myWebbedSite
      #Available at: https://sites.wisp.place/did:plc:ttdrpj45ibqunmfhdsb4zdwq/myWebbedSite
        `}
									language="yaml"
								/>
							</div>

							<div>
								<h4 className="text-xs font-semibold mb-2 flex items-center gap-2">
									<span>Example 2: React/Vite Build & Deploy</span>
									<Badge variant="secondary" className="text-xs">Full Build</Badge>
								</h4>
								<CodeBlock
									code={`when:
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
  SITE_NAME: 'my-react-site'
  WISP_HANDLE: 'your-handle.bsky.social'

steps:
  - name: build site
    command: |
      # necessary to ensure bun is in PATH
      export PATH="$HOME/.nix-profile/bin:$PATH"

      bun install --frozen-lockfile

      # build with vite, run directly to get around env issues
      bun node_modules/.bin/vite build

  - name: deploy to wisp
    command: |
      # Download Wisp CLI
      curl https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli

      # Deploy to Wisp
      ./wisp-cli \\
        "$WISP_HANDLE" \\
        --path "$SITE_PATH" \\
        --site "$SITE_NAME" \\
        --password "$WISP_APP_PASSWORD"`}
									language="yaml"
								/>
							</div>
						</div>

						<div className="p-3 bg-muted/30 rounded-lg border-l-4 border-accent">
							<p className="text-xs text-muted-foreground">
								<strong className="text-foreground">Note:</strong> Set <code className="px-1.5 py-0.5 bg-background rounded text-xs">WISP_APP_PASSWORD</code> as a secret in your Tangled Spindle repository settings.
								Generate an app password from your AT Protocol account settings.
							</p>
						</div>
					</div>

					<div className="space-y-3">
						<h3 className="text-sm font-semibold">Learn More</h3>
						<div className="grid gap-2">
							<a
								href="https://tangled.org/@nekomimi.pet/wisp.place-monorepo/tree/main/cli"
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center justify-between p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border"
							>
								<span className="text-sm">Source Code</span>
								<ExternalLink className="w-4 h-4 text-muted-foreground" />
							</a>
							<a
								href="https://blog.tangled.org/ci"
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center justify-between p-3 bg-muted/50 hover:bg-muted rounded-lg transition-colors border border-border"
							>
								<span className="text-sm">Tangled Spindle CI/CD</span>
								<ExternalLink className="w-4 h-4 text-muted-foreground" />
							</a>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	)
}
