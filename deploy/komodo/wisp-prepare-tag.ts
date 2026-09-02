// One-time preparation for tag-driven releases.
//
// File contents of the Komodo Action `wisp-prepare-tag`. Run it once, by
// hand, before the first tagged release; `wisp-release` does the rest.
//
//   ARGS = { repo: "owner/name", apply?: true, seed?: "<tag>" }
//
// Without `apply` it changes nothing: it renders the edit beside the real
// files, diffs it, and throws the previews away. Run it that way first.
//
// What it does: rewrites the `image:` lines that point at our own registry
// so they read a variable instead of a hardcoded tag, and seeds that
// variable at each stack's current tag so the first deploy is a no-op.
//
// Like wisp-release, this hardcodes nothing about the fleet — hosts, compose
// paths and env files all come back from Komodo at run time.

const TAG_VAR = 'WISP_TAG'

const repo = String(ARGS.repo ?? '').trim()
const apply = ARGS.apply === true || ARGS.apply === 'true'
const seedArg = String(ARGS.seed ?? '').trim()

if (!repo) {
	throw new Error('missing repo arg (the source repo the builds clone)')
}

const imageRepo = (ref: string): string => {
	const slash = ref.lastIndexOf('/')
	const colon = ref.lastIndexOf(':')
	return colon > slash ? ref.slice(0, colon) : ref
}

const imageTag = (ref: string): string => {
	const slash = ref.lastIndexOf('/')
	const colon = ref.lastIndexOf(':')
	return colon > slash ? ref.slice(colon + 1) : ''
}

const withVar = (env: string, key: string, value: string): string => {
	const kept = (env ?? '')
		.split('\n')
		.filter((line) => !new RegExp(`^\\s*${key}\\s*=`).test(line))
		.join('\n')
		.trimEnd()
	return `${kept ? `${kept}\n` : ''}${key}=${value}\n`
}

// The server terminal is a live bash session, not a script runner. It
// appends its own exit-code marker to the LAST LINE of whatever it is sent,
// and echoes the shell prompt between lines. A multi-line script therefore
// reports only its final line's status, interleaves prompt noise into the
// output, and — if any line leaves bash waiting for more input — hangs
// forever with no marker and no timeout.
//
// So everything goes over as exactly one line: the script base64-encoded and
// piped into a fresh non-interactive bash. The marker then reflects that
// bash's exit status, which is what we actually want to know.
const sh = async (server: string, script: string): Promise<string> => {
	const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(script)))
	const command = `printf %s '${encoded}' | base64 -d | bash`

	const lines: string[] = []
	let code: string | undefined
	await komodo.execute_server_terminal(
		{ server, command, init: { command: 'bash' } },
		{
			onLine: (line) => {
				lines.push(line)
			},
			onFinish: (c) => {
				code = c
			},
		},
	)
	const out = lines.join('\n').trim()
	// onFinish also fires with "Early exit without code" when the stream
	// ends without a marker — that is a failure, not a pass.
	if (code !== '0') {
		throw new Error(`[${server}] exit ${code ?? '?'}\n${out}`)
	}
	return out
}

// ------------------------------------------------ discover what we build

const builds = (await komodo.read('ListBuilds', {})).filter((b: any) => b.info?.repo === repo)
if (!builds.length) {
	throw new Error(`no Komodo build clones '${repo}'`)
}

const images: string[] = []
for (const build of builds) {
	const config = (await komodo.read('GetBuild', { build: build.name })).config
	const registry = (config.image_registry ?? [])[0]
	if (!registry?.domain) continue
	images.push(
		[registry.domain, registry.organization || registry.account, config.image_name || build.name]
			.filter(Boolean)
			.join('/'),
	)
}

const ours = (image: string) => images.includes(imageRepo(image))

const stacks = (await komodo.read('ListStacks', {})).filter((s: any) =>
	(s.info?.services ?? []).some((svc: any) => svc.image && ours(svc.image)),
)
if (!stacks.length) {
	throw new Error(`no stack runs any of: ${images.join(', ')}`)
}

console.log(`${apply ? 'applying to' : 'dry run over'} ${stacks.length} stacks`)

// -------------------------------------------------------- per stack

for (const stack of stacks) {
	const server = stack.info?.server_name
	const config = (await komodo.read('GetStack', { stack: stack.name })).config
	const dir = config.run_directory
	const files: string[] = config.file_paths ?? []

	console.log(`\n── ${stack.name} (${server})`)

	// The seed keeps this stack exactly where it already is. It can only be
	// inferred when every one of our services here is on the same tag; if
	// they are drifted, picking one silently rolls the others back.
	const tags = [
		...new Set(
			(stack.info?.services ?? []).filter((s: any) => s.image && ours(s.image)).map((s: any) => imageTag(s.image)),
		),
	]
	const seed = seedArg || (tags.length === 1 ? (tags[0] as string) : '')
	if (!seed) {
		throw new Error(
			`${stack.name} is drifted across tags (${tags.join(', ')}). ` +
				'Seeding from one would roll the others back — pass an explicit seed arg.',
		)
	}

	// Every env file Komodo passes, in its order, so the render matches what
	// actually deploys. Komodo's own env file may not exist until the first
	// deploy writes it, so only pass the ones that are actually there.
	const envFiles = [config.env_file_path, ...(config.additional_env_files ?? []).map((a: any) => a.path)]
		.filter(Boolean)
		.map((p: string) => (p.startsWith('/') ? p : `${dir}/${p}`))

	// A grep-style alternation of our image repos, for sed and for grep.
	const pattern = images.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')

	const script = [
		`set -euo pipefail`,
		`cd '${dir}'`,
		`envargs=()`,
		`for f in ${envFiles.map((f) => `'${f}'`).join(' ')}; do [ -f "$f" ] && envargs+=(--env-file "$f"); done`,
		// a temp env file supplies the variable for the preview render only;
		// passed last so it wins, and never written into the stack's own files
		`printf '${TAG_VAR}=%s\\n' '${seed}' > /tmp/wisptag.env`,
		`before=(); after=(); touched=()`,
		...files.map(
			(f) => `
if grep -qE '^[[:space:]]*image:[[:space:]]*(${pattern}):' '${f}'; then
  sed -E 's#^([[:space:]]*image:[[:space:]]*(${pattern})):[^[:space:]]*#\\1:\\$\\{${TAG_VAR}\\}#' '${f}' > '${f}.wisptag-preview'
  after+=(-f '${f}.wisptag-preview'); touched+=('${f}')
else
  after+=(-f '${f}')
fi
before+=(-f '${f}')`,
		),
		`if [ \${#touched[@]} -eq 0 ]; then echo "  nothing to rewrite"; rm -f /tmp/wisptag.env; exit 0; fi`,
		`echo "  rewriting: \${touched[*]}"`,
		`echo "  seed: ${TAG_VAR}=${seed}"`,
		`docker compose "\${envargs[@]}" "\${before[@]}" config > /tmp/wisptag.before`,
		`docker compose "\${envargs[@]}" --env-file /tmp/wisptag.env "\${after[@]}" config > /tmp/wisptag.after`,
		// an empty interpolation still diffs cleanly, so catch it explicitly
		`if grep -qE "^[[:space:]]*image: '?[^:']*:'?\\$" /tmp/wisptag.after; then`,
		`  echo "  REFUSING: ${TAG_VAR} did not reach the renderer — tags came out empty" >&2; exit 1`,
		`fi`,
		// Only image: lines may differ. Everything else is reported by key and
		// never by value: a rendered compose file contains credentials, and
		// comparing them is the point while printing them is the hazard.
		`other="$(diff /tmp/wisptag.before /tmp/wisptag.after | grep -E '^[<>]' | grep -vE '^[<>][[:space:]]*image:' | sed -E 's/^([<>])[[:space:]]*([^:]*):.*/\\1 \\2/' | sort -u || true)"`,
		`imagediff="$(diff /tmp/wisptag.before /tmp/wisptag.after | grep -E '^[<>][[:space:]]*image:' || true)"`,
		`[ -n "$imagediff" ] && echo "$imagediff" | sed 's/^/    /' || echo "    (identical)"`,
		`if [ -n "$other" ]; then echo "  REFUSING: render differs outside image: lines —" >&2; echo "$other" | sed 's/^/    /' >&2; exit 1; fi`,
		`echo "  gate ok: nothing but image: lines changed"`,
		`rm -f /tmp/wisptag.env /tmp/wisptag.before /tmp/wisptag.after`,
		apply
			? `stamp=$(date -u +%Y%m%dT%H%M%SZ)
for f in "\${touched[@]}"; do cp "$f" "$f.bak-wisptag-$stamp"; mv "$f.wisptag-preview" "$f"; echo "  applied $f (backup: $f.bak-wisptag-$stamp)"; done`
			: `rm -f "\${touched[@]/%/.wisptag-preview}"; echo "  dry run — previews discarded"`,
	].join('\n')

	console.log(await sh(server, script))

	if (apply) {
		await komodo.write('UpdateStack', {
			id: stack.name,
			config: { environment: withVar(config.environment ?? '', TAG_VAR, seed) },
		})
		console.log(`  seeded stack environment with ${TAG_VAR}=${seed}`)
	}
}

console.log(
	apply
		? '\nprepared. the next v* tag builds every image at one version and unifies the fleet.'
		: '\ndry run complete — re-run with apply to commit the change.',
)
