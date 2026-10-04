import type { UserInfo } from '../api'
import { WISPCTL_VERSION as VERSION } from '../recipes'
import { CodeBlock, CopyButton, ExternalLink, Section } from '../ui'
import { PreviewsSection } from './previews'

const BINARY_BASE = 'https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries'

// Checksums are duplicated in binaries/index.html and docs/src/content/docs/cli.md; keep them in step.
const BINARIES = [
	{
		platform: 'macos · apple silicon',
		filename: 'wisp-cli-aarch64-darwin',
		sha256: 'fd00750c33566ba474543857243a4c5f18d1b750591f71276b06fe4dbca0dae0',
	},
	{
		platform: 'macos · intel',
		filename: 'wisp-cli-x86_64-darwin',
		sha256: '3d5259680b3438f98fe6e5701b9e65557aa56ab65aabe44cd54b05402c5641e5',
	},
	{
		platform: 'linux · arm64',
		filename: 'wisp-cli-aarch64-linux',
		sha256: 'c3505505287c60e7193208663a89b87ece82cf2c5fb809a84444c63bea99c5f4',
	},
	{
		platform: 'linux · x86_64',
		filename: 'wisp-cli-x86_64-linux',
		sha256: 'f97dcb95a1fb9bcd56c972bc5c44af1f09f53c77a222a28476316a950ee553a6',
	},
	{
		platform: 'windows · x86_64',
		filename: 'wisp-cli-x86_64-windows.exe',
		sha256: '9dce3069f43a90cb03204d9175d54e1ea12d19fe371747c24807badeab68d3bd',
	},
] as const

const INSTALL = [
	{ command: 'npm install -g wispctl', note: 'recommended' },
	{ command: 'npm create wisp@latest', note: 'scaffold a new project' },
] as const

const LINKS = [
	{ label: 'docs', href: 'https://docs.wisp.place/cli/' },
	{ label: 'source', href: 'https://tangled.org/nekomimi.pet/wisp.place-monorepo/tree/main/cli-rs' },
	{ label: 'spindle ci', href: 'https://blog.tangled.org/ci' },
] as const

const DEPLOY_STEP = `npm install --global --prefix "$HOME/.local" wispctl@${VERSION}
      export PATH="$HOME/.local/bin:$PATH"
      wispctl deploy "$WISP_HANDLE" \\
        --path "$SITE_PATH" \\
        --site "$SITE_NAME" \\
        --password "$WISP_APP_PASSWORD" \\
        --yes`

const RECIPES = [
	{
		title: 'deploy · pull · serve',
		snippets: [
			{
				label: 'deploy',
				code: `wispctl deploy your-handle.bsky.social \\
  --path ./dist \\
  --site my-site

# https://sites.wisp.place/your-handle/my-site`,
			},
			{
				label: 'pull',
				code: `wispctl pull your-handle.bsky.social \\
  --site my-site --path ./my-site`,
			},
			{
				label: 'serve with live updates',
				code: `wispctl serve your-handle.bsky.social --site my-site
wispctl serve your-handle.bsky.social --site my-site --port 3000
wispctl serve your-handle.bsky.social --site my-site --spa`,
			},
		],
	},
	{
		title: 'domains · sites',
		snippets: [
			{
				label: 'manage',
				code: `wispctl domain claim your-handle.bsky.social --domain example.com
wispctl domain claim-subdomain your-handle.bsky.social --subdomain alice
wispctl domain status your-handle.bsky.social --domain example.com
wispctl domain add-site your-handle.bsky.social --domain example.com --site mysite
wispctl domain delete your-handle.bsky.social --domain example.com
wispctl site delete your-handle.bsky.social --site mysite
wispctl list domains your-handle.bsky.social
wispctl list sites your-handle.bsky.social`,
			},
		],
	},
	{
		title: 'deploy on push · tangled spindle',
		snippets: [
			{
				label: 'deploy on push',
				code: `steps:
  - name: deploy to wisp
    command: |
      ${DEPLOY_STEP}`,
			},
			{
				label: 'build with vite, then deploy',
				code: `when:
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
      ${DEPLOY_STEP}`,
			},
		],
		note: "add WISP_APP_PASSWORD (an app password) to the repo's spindle secrets on tangled",
	},
]

export function CliView({ user }: { user: UserInfo | undefined }) {
	return (
		<>
			<Section
				title="wispctl"
				meta={`v${VERSION}`}
				actions={LINKS.map((link) => (
					<ExternalLink key={link.href} href={link.href} className="text-xs">
						{link.label}
					</ExternalLink>
				))}
			>
				<p className="hint my-2">
					deploy from a terminal or ci, or run your own little server that follows the firehose
				</p>
				<ul className="rows">
					{INSTALL.map(({ command, note }) => (
						<li key={command} className="flex flex-wrap items-center gap-x-4 py-2 pl-6">
							<code className="font-bold">
								<span className="text-rose">$ </span>
								{command}
							</code>
							<span className="text-xs text-ink-soft">{note}</span>
							<span className="ml-auto">
								<CopyButton text={command} />
							</span>
						</li>
					))}
				</ul>
			</Section>

			<PreviewsSection user={user} />

			<Section title="recipes">
				{RECIPES.map((recipe) => (
					<details key={recipe.title} className="group border-b border-dashed border-rule">
						<summary className="cursor-pointer list-none py-2.5 pl-6 font-bold marker:hidden hover:bg-paper-2 [&::-webkit-details-marker]:hidden">
							<span className="mr-2 inline-block text-rose transition-transform group-open:rotate-90">▸</span>
							{recipe.title}
						</summary>
						<div className="space-y-4 pb-5 pl-6">
							{recipe.snippets.map((snippet) => (
								<div key={snippet.label}>
									<p className="field-label">{snippet.label}</p>
									<CodeBlock code={snippet.code} />
								</div>
							))}
							{recipe.note && <p className="hint">{recipe.note}</p>}
						</div>
					</details>
				))}
			</Section>

			<Section title="binaries" meta={`v${VERSION} · static builds, no runtime needed`}>
				<ul className="rows">
					{BINARIES.map(({ platform, filename, sha256 }) => (
						<li key={filename} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 pl-6">
							<span className="w-56 shrink-0 font-bold">{platform}</span>
							<a href={`${BINARY_BASE}/${filename}`} download className="text-xs">
								{filename} ↓
							</a>
							<code className="min-w-0 flex-1 truncate text-xs text-ink-soft" title={sha256}>
								sha256 {sha256}
							</code>
							<CopyButton text={sha256} label="copy sha" />
						</li>
					))}
				</ul>
			</Section>
		</>
	)
}
