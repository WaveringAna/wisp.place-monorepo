import { useId, useState } from 'react'
import type { UserInfo } from '../api'
import { type RowProps, useRovingList } from '../keys'
import { WISPCTL_VERSION as VERSION } from '../recipes'
import { CHEVRON, CodeBlock, type Column, CopyButton, DetailRow, ExternalLink, Row, Section, Sheet, Tag } from '../ui'
import { PreviewsSection } from './previews'

const BINARY_BASE = 'https://sites.wisp.place/nekomimi.pet/wisp-cli-binaries'

// Checksums are duplicated in binaries/index.html and docs/src/content/docs/cli.md; keep them in step.
const BINARIES = [
	{
		platform: 'macos · apple silicon',
		filename: 'wisp-cli-aarch64-darwin',
		sha256: '28026797cc909a9101e459ff901768203e5bcbefc96eff1d00cf00f190601940',
	},
	{
		platform: 'macos · intel',
		filename: 'wisp-cli-x86_64-darwin',
		sha256: '537f2d7905b9b2c07ff778bd7d1aa6b7ee7c082bd8f6f59ef86a0e4729e5a4e7',
	},
	{
		platform: 'linux · arm64',
		filename: 'wisp-cli-aarch64-linux',
		sha256: 'ac5d72d1ddda95dc992add98bda56cb8519120407f6d31b8c1a58182d22f2299',
	},
	{
		platform: 'linux · x86_64',
		filename: 'wisp-cli-x86_64-linux',
		sha256: '79a6250c5bcc0d2cf6b93a7a7550255bba78351af73566aca908f07a5def8fbc',
	},
	{
		platform: 'windows · x86_64',
		filename: 'wisp-cli-x86_64-windows.exe',
		sha256: '0ea68a9f0c9bf3a9973882645adc13befdc3698fdd8c11556594be2d7979f002',
	},
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

const recipesFor = (handle: string) => [
	{
		title: 'deploy · pull · serve',
		snippets: [
			{
				label: 'deploy',
				code: `wispctl deploy ${handle} \\
  --path ./dist \\
  --site my-site

# https://sites.wisp.place/${handle}/my-site`,
			},
			{
				label: 'pull',
				code: `wispctl pull ${handle} \\
  --site my-site --path ./my-site`,
			},
			{
				label: 'serve with live updates',
				code: `wispctl serve ${handle} --site my-site
wispctl serve ${handle} --site my-site --port 3000
wispctl serve ${handle} --site my-site --spa`,
			},
		],
	},
	{
		title: 'domains · sites',
		snippets: [
			{
				label: 'manage',
				code: `wispctl domain claim ${handle} --domain example.com
wispctl domain claim-subdomain ${handle} --subdomain alice
wispctl domain status ${handle} --domain example.com
wispctl domain add-site ${handle} --domain example.com --site mysite
wispctl domain delete ${handle} --domain example.com
wispctl site delete ${handle} --site mysite
wispctl list domains ${handle}
wispctl list sites ${handle}`,
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
  WISP_HANDLE: '${handle}'

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

const RECIPE_COLUMNS: readonly Column[] = [
	CHEVRON,
	{ name: 'recipe' },
	{ name: 'snippets', className: 'max-sm:hidden' },
]

const BINARY_COLUMNS: readonly Column[] = [
	{ name: 'platform' },
	{ name: 'file' },
	{ name: 'sha256', className: 'max-sm:hidden' },
	{ name: 'actions', label: '' },
]

const installCommand = (handle: string) => `npm install -g wispctl
wispctl deploy ${handle} --path ./dist --site my-site`

const CREATE_COMMAND = 'npm create wisp@latest'

export function CliView({ user }: { user: UserInfo | undefined }) {
	const [open, setOpen] = useState<string | null>(null)
	// The handle fills every example, so each one can be pasted as-is.
	const handle = user?.handle ?? 'your-handle.bsky.social'
	const recipes = recipesFor(handle)
	const rowProps = useRovingList(recipes.length)

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
				<div className="grid gap-4 sm:grid-cols-2">
					<div>
						<p className="field-label">
							<span className="text-ink">install</span> · node 20+
						</p>
						<CodeBlock title="bash" code={installCommand(handle)} />
					</div>
					<div>
						<p className="field-label">
							<span className="text-ink">or without installing</span> · asks for handle, directory and site
						</p>
						<CodeBlock title="bash" code={CREATE_COMMAND} />
					</div>
				</div>
			</Section>

			<PreviewsSection user={user} />

			<Section title="recipes">
				<Sheet columns={RECIPE_COLUMNS}>
					{recipes.map((recipe, index) => (
						<RecipeRow
							key={recipe.title}
							recipe={recipe}
							expanded={open === recipe.title}
							onToggle={() => setOpen((current) => (current === recipe.title ? null : recipe.title))}
							rowProps={rowProps(index)}
						/>
					))}
				</Sheet>
			</Section>

			<Section title="binaries" meta={`v${VERSION} · static builds, no runtime needed`}>
				<Sheet columns={BINARY_COLUMNS}>
					{BINARIES.map(({ platform, filename, sha256 }) => (
						<tr key={filename}>
							<td className="name">{platform}</td>
							<td className="whitespace-nowrap">
								<a href={`${BINARY_BASE}/${filename}`} download>
									{filename} ↓
								</a>
							</td>
							<td className="max-w-0 truncate text-xs max-sm:hidden" title={sha256}>
								{sha256}
							</td>
							<td className="acts">
								<CopyButton text={sha256} label="copy sha" />
							</td>
						</tr>
					))}
				</Sheet>
			</Section>
		</>
	)
}

interface RecipeRowProps {
	recipe: ReturnType<typeof recipesFor>[number]
	expanded: boolean
	onToggle: () => void
	rowProps: RowProps
}

function RecipeRow({ recipe, expanded, onToggle, rowProps }: RecipeRowProps) {
	const detailId = useId()
	return (
		<>
			<Row rowProps={rowProps} onActivate={onToggle} expanded={expanded} controls={detailId}>
				<td className="chev" />
				<td className="name">{recipe.title}</td>
				<td className="max-sm:hidden">
					<span className="flex flex-wrap gap-1">
						{recipe.snippets.map((snippet) => (
							<Tag key={snippet.label}>{snippet.label}</Tag>
						))}
					</span>
				</td>
			</Row>
			{expanded && (
				<DetailRow id={detailId} span={RECIPE_COLUMNS.length}>
					<div className="space-y-4">
						{recipe.snippets.map((snippet) => (
							<CodeBlock key={snippet.label} title={snippet.label} code={snippet.code} />
						))}
						{recipe.note && <p className="hint">{recipe.note}</p>}
					</div>
				</DetailRow>
			)}
		</>
	)
}
