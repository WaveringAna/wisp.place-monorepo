import { Badge } from '@public/components/ui/badge'
import { CodeBlock } from '@public/components/ui/code-block'
import { Download, ExternalLink } from 'lucide-react'

const BASE_URL = 'https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries'

const BINARIES = [
	{
		platform: 'macOS (Apple Silicon)',
		filename: 'wisp-cli-aarch64-darwin',
		sha256: '06544b3a3e27a4b8d7b3a46a39fb7205cf90b3061e19fe533b090facd604f375',
	},
	{
		platform: 'macOS (Intel)',
		filename: 'wisp-cli-x86_64-darwin',
		sha256: '9ec523e3ceef927b37adc52d449dcd9e13ea84fa49b0b77f0d5932c94cfe262e',
	},
	{
		platform: 'Linux (ARM64)',
		filename: 'wisp-cli-aarch64-linux',
		sha256: '42a262668e13dce36173a4096cdc2b22358b805cf192335f84534c7f695d395b',
	},
	{
		platform: 'Linux (x86_64)',
		filename: 'wisp-cli-x86_64-linux',
		sha256: '589ee59f3959ddfbc12fea38d2bcb91701f1362f560ae6fd506bebea3150e2cc',
	},
] as const

const LINKS = [
	{ label: 'Docs', href: 'https://docs.wisp.place/cli' },
	{
		label: 'Source',
		href: 'https://tangled.org/@nekomimi.pet/wisp.place-monorepo/tree/main/cli',
	},
	{ label: 'Spindle CI/CD', href: 'https://blog.tangled.org/ci' },
] as const

function SectionLabel({ children }: { children: React.ReactNode }) {
	return (
		<p className="text-xs uppercase tracking-wider text-muted-foreground pb-2 mb-3 border-b border-border/50">
			{children}
		</p>
	)
}

export function CLITab() {
	return (
		<div className="h-full flex flex-col border border-border/30 bg-card/50 font-mono">
			{/* Header */}
			<div className="px-4 py-3 border-b border-border/50 flex-shrink-0 flex items-center justify-between gap-4 bg-card">
				<div className="flex items-center gap-2">
					<span className="text-sm font-semibold">Wisp CLI</span>
					<Badge variant="secondary" className="text-xs">
						v1.0.0
					</Badge>
				</div>
				<div className="flex items-center gap-4">
					{LINKS.map(({ label, href }) => (
						<a
							key={href}
							href={href}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 transition-colors"
						>
							{label}
							<ExternalLink className="w-3 h-3" />
						</a>
					))}
				</div>
			</div>

			{/* Scrollable content */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				{/* Quick install */}
				<div className="p-4 border-b border-border/50">
					<SectionLabel>Install</SectionLabel>
					<div className="space-y-2">
						<div className="flex items-center gap-3 px-3 py-2.5 bg-muted/40 border border-border/60">
							<span className="text-accent text-xs select-none shrink-0">$</span>
							<code className="text-sm flex-1">npm install -g wispctl</code>
							<span className="text-[10px] text-muted-foreground border border-border/50 px-1.5 py-0.5 shrink-0">
								recommended
							</span>
						</div>
						<div className="flex items-center gap-3 px-3 py-2.5 bg-muted/40 border border-border/60">
							<span className="text-accent text-xs select-none shrink-0">$</span>
							<code className="text-sm flex-1">npm create wisp@latest</code>
							<span className="text-[10px] text-muted-foreground shrink-0">scaffold a project</span>
						</div>
					</div>
				</div>

				{/* Binary downloads */}
				<div className="p-4 border-b border-border/50">
					<SectionLabel>Binary Downloads v1.0.0</SectionLabel>
					<div className="grid grid-cols-2 gap-2">
						{BINARIES.map(({ platform, filename, sha256 }) => (
							<a
								key={filename}
								href={`${BASE_URL}/${filename}`}
								download
								className="flex items-start justify-between gap-2 p-3 bg-card border border-border/60 hover:bg-muted/40 hover:border-border transition-colors group"
							>
								<div className="min-w-0">
									<div className="text-xs font-medium leading-snug">{platform}</div>
									<div className="font-mono text-[10px] text-muted-foreground mt-1 truncate">sha256: {sha256}</div>
								</div>
								<Download className="w-3.5 h-3.5 text-muted-foreground group-hover:text-accent transition-colors flex-shrink-0 mt-0.5" />
							</a>
						))}
					</div>
				</div>

				{/* Commands */}
				<div className="p-4 space-y-2">
					<SectionLabel>Commands</SectionLabel>

					<details className="group border border-border/60 open:border-accent/40">
						<summary className="flex items-center justify-between px-3 py-2.5 bg-muted/30 cursor-pointer hover:bg-muted/50 select-none list-none [&::-webkit-details-marker]:hidden transition-colors">
							<span className="text-sm">
								<span className="text-accent mr-2">$</span>
								deploy · pull · serve
							</span>
							<span className="text-accent font-medium text-sm leading-none group-open:hidden">+</span>
							<span className="text-accent font-medium text-sm leading-none hidden group-open:inline">−</span>
						</summary>
						<div className="border-t border-border/50 p-4 space-y-4 bg-background">
							<div className="space-y-1.5">
								<p className="text-xs text-muted-foreground font-medium">Deploy</p>
								<CodeBlock
									code={`./wisp-cli deploy your-handle.bsky.social \\
  --path ./dist \\
  --site my-site

# https://sites.wisp.place/your-handle/my-site`}
									language="bash"
								/>
							</div>
							<div className="space-y-1.5">
								<p className="text-xs text-muted-foreground font-medium">Pull</p>
								<CodeBlock
									code={`./wisp-cli pull your-handle.bsky.social \\
  --site my-site --output ./my-site`}
									language="bash"
								/>
							</div>
							<div className="space-y-1.5">
								<p className="text-xs text-muted-foreground font-medium">Serve with live updates</p>
								<CodeBlock
									code={`./wisp-cli serve your-handle.bsky.social --site my-site
./wisp-cli serve your-handle.bsky.social --site my-site --port 3000
./wisp-cli serve your-handle.bsky.social --site my-site --spa`}
									language="bash"
								/>
							</div>
						</div>
					</details>

					<details className="group border border-border/60 open:border-accent/40">
						<summary className="flex items-center justify-between px-3 py-2.5 bg-muted/30 cursor-pointer hover:bg-muted/50 select-none list-none [&::-webkit-details-marker]:hidden transition-colors">
							<span className="text-sm">
								<span className="text-accent mr-2">$</span>
								domain · site management
							</span>
							<span className="text-accent font-medium text-sm leading-none group-open:hidden">+</span>
							<span className="text-accent font-medium text-sm leading-none hidden group-open:inline">−</span>
						</summary>
						<div className="border-t border-border/50 p-4 bg-background">
							<CodeBlock
								code={`./wisp-cli domain claim your-handle.bsky.social --domain example.com
./wisp-cli domain claim-subdomain your-handle.bsky.social --subdomain alice
./wisp-cli domain status your-handle.bsky.social --domain example.com
./wisp-cli domain add-site your-handle.bsky.social --domain example.com --site mysite
./wisp-cli domain delete your-handle.bsky.social --domain example.com
./wisp-cli site delete your-handle.bsky.social --site mysite
./wisp-cli list domains your-handle.bsky.social
./wisp-cli list sites your-handle.bsky.social`}
								language="bash"
							/>
						</div>
					</details>

					<details className="group border border-border/60 open:border-accent/40">
						<summary className="flex items-center justify-between px-3 py-2.5 bg-muted/30 cursor-pointer hover:bg-muted/50 select-none list-none [&::-webkit-details-marker]:hidden transition-colors">
							<span className="text-sm">
								<span className="text-accent mr-2">$</span>
								CI/CD — Tangled Spindle
							</span>
							<span className="text-accent font-medium text-sm leading-none group-open:hidden">+</span>
							<span className="text-accent font-medium text-sm leading-none hidden group-open:inline">−</span>
						</summary>
						<div className="border-t border-border/50 p-4 space-y-4 bg-background">
							<div className="space-y-1.5">
								<p className="text-xs text-muted-foreground font-medium">Simple deploy</p>
								<CodeBlock
									code={`steps:
  - name: deploy to wisp
    command: |
      curl ${BASE_URL}/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli
      ./wisp-cli deploy "$WISP_HANDLE" \\
        --path "$SITE_PATH" \\
        --site "$SITE_NAME" \\
        --password "$WISP_APP_PASSWORD"`}
									language="yaml"
								/>
							</div>
							<div className="space-y-1.5">
								<p className="text-xs text-muted-foreground font-medium">React / Vite build &amp; deploy</p>
								<CodeBlock
									code={`when:
  - event: ['push']
    branch: ['main']

engine: 'nixery'
dependencies:
  nixpkgs: [nodejs, coreutils, curl, glibc]
  github:NixOS/nixpkgs/nixpkgs-unstable: [bun]

environment:
  SITE_PATH: 'dist'
  SITE_NAME: 'my-site'
  WISP_HANDLE: 'your-handle.bsky.social'

steps:
  - name: build
    command: |
      export PATH="$HOME/.nix-profile/bin:$PATH"
      bun install --frozen-lockfile
      bun node_modules/.bin/vite build
  - name: deploy
    command: |
      curl ${BASE_URL}/wisp-cli-x86_64-linux -o wisp-cli
      chmod +x wisp-cli
      ./wisp-cli deploy "$WISP_HANDLE" \\
        --path "$SITE_PATH" \\
        --site "$SITE_NAME" \\
        --password "$WISP_APP_PASSWORD"`}
									language="yaml"
								/>
							</div>
							<p className="text-xs text-muted-foreground border-l-2 border-accent/60 pl-3">
								Set <code className="px-1 py-0.5 bg-muted/60 border border-border/50">WISP_APP_PASSWORD</code> as a
								secret in your Spindle repo settings.
							</p>
						</div>
					</details>
				</div>
			</div>
		</div>
	)
}
