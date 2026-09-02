// Fleet release.
//
// File contents of the Komodo Action `wisp-release`. Kept in git so changes
// are reviewable; paste it into the Action after editing here.
//
// Invoked by .tangled/workflows/release.yml on a v* tag with:
//   ARGS = { version: "1.2.3", commit: "<40-char sha>", repo: "owner/name" }
//
// Nothing about the fleet is written down here. Which images exist, which
// hosts run them, where their compose lives — all of it is read back from
// Komodo at run time, keyed off the one thing this repo legitimately knows
// about itself: the repo its builds are built from. Adding or removing a
// node or a service needs no change to this file.
//
// Komodo wraps this in `async function main()` on Deno and provides `ARGS`,
// `komodo`, `Types`, `YAML`, `TOML`. Anything thrown fails the Action, which
// fails the CI pipeline. Those globals do not exist locally, so `deploy` is
// excluded from the root tsconfig and this file is not covered by
// `bun check`; Komodo's editor is type-aware and checks it there.

const TAG_VAR = 'WISP_TAG'

// A service already on the right tag but never restarted is the
// deploy-reported-success-without-pulling failure. Anything older than this
// at verification time means the deploy did not actually happen.
const MAX_CONTAINER_AGE_SECONDS = 900

const version = String(ARGS.version ?? '').trim()
const commit = String(ARGS.commit ?? '').trim()
const repo = String(ARGS.repo ?? '').trim()

if (!/^\d+\.\d+\.\d+$/.test(version)) {
	throw new Error(`bad version arg: '${version}' (want major.minor.patch)`)
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
	throw new Error(`bad commit arg: '${commit}' (want a full 40-char sha)`)
}
if (!repo) {
	throw new Error('missing repo arg (the source repo the builds clone)')
}

// ---------------------------------------------------------------- helpers

// Strip the tag from an image reference, leaving the repository path.
// A colon only introduces a tag when it sits in the last path segment.
const imageRepo = (ref: string): string => {
	const slash = ref.lastIndexOf('/')
	const colon = ref.lastIndexOf(':')
	return colon > slash ? ref.slice(0, colon) : ref
}

// Replace or append a single KEY=value line, leaving every other line alone.
const withVar = (env: string, key: string, value: string): string => {
	const kept = (env ?? '')
		.split('\n')
		.filter((line) => !new RegExp(`^\\s*${key}\\s*=`).test(line))
		.join('\n')
		.trimEnd()
	return `${kept ? `${kept}\n` : ''}${key}=${value}\n`
}

// ------------------------------------------- 1. discover what we build

const builds = (await komodo.read('ListBuilds', {})).filter((b: any) => b.info?.repo === repo)

if (!builds.length) {
	throw new Error(`no Komodo build clones '${repo}' — nothing to release`)
}

// The fully-qualified image each build pushes, so stacks can be matched by
// what they actually run rather than by name.
const images: string[] = []

for (const build of builds) {
	const config = (await komodo.read('GetBuild', { build: build.name })).config
	const registry = (config.image_registry ?? [])[0]
	if (!registry?.domain) {
		throw new Error(`build ${build.name} has no image registry configured`)
	}
	images.push(
		[registry.domain, registry.organization || registry.account, config.image_name || build.name]
			.filter(Boolean)
			.join('/'),
	)
}

console.log(`releasing ${version} from ${commit.slice(0, 7)} — ${builds.length} images`)

// ------------------------------------------ 2. pin version and commit

// Without the commit pin a build clones whatever is on the tracked branch
// right now, which is not necessarily what was tagged.
for (const build of builds) {
	await komodo.write('UpdateBuild', {
		id: build.name,
		config: { version: version as any, auto_increment_version: false, commit },
	})
}

// ------------------------------------------------------ 3. build images

// Sequential, not parallel, on purpose. Registry tokens here are short lived
// and an expired one comes back as 403 rather than 401, so Docker gives up
// instead of re-authenticating. Builds contending for one builder stretch
// each login->push window past the token lifetime; one at a time keeps each
// window short.
//
// One retry, because the correct response to a push 403 is to try again
// against the now-warm cache, not to change any config.
for (const build of builds) {
	let ok = false
	for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
		const update = await komodo.execute('RunBuild', { build: build.name })
		ok = update.success
		if (!ok) {
			console.log(`build ${build.name} failed (attempt ${attempt}/2), update ${update.id}`)
			if (attempt === 2) {
				throw new Error(`build ${build.name} failed twice — see Komodo update ${update.id}`)
			}
		}
	}
	console.log(`built ${build.name}:${version}`)
}

// -------------------------------------- 4. find the stacks that run them

const ours = (image: string) => images.includes(imageRepo(image))

const stacks = (await komodo.read('ListStacks', {})).filter((s: any) =>
	(s.info?.services ?? []).some((svc: any) => svc.image && ours(svc.image)),
)

if (!stacks.length) {
	throw new Error(`built ${version} but no stack runs any of: ${images.join(', ')}`)
}

// ---------------------------------------------------------- 5. deploy

// The tag moves through the stack's own environment, which Komodo owns and
// writes out at deploy time. Compose files are hand-maintained and carry
// per-host detail this release knows nothing about, so nothing here renders,
// templates or rewrites one.
for (const stack of stacks) {
	const config = (await komodo.read('GetStack', { stack: stack.name })).config
	await komodo.write('UpdateStack', {
		id: stack.name,
		config: { environment: withVar(config.environment ?? '', TAG_VAR, version) },
	})

	const update = await komodo.execute('DeployStack', { stack: stack.name })
	if (!update.success) {
		throw new Error(`DeployStack ${stack.name} failed — see Komodo update ${update.id}`)
	}
	console.log(`deployed ${stack.name}`)
}

// ---------------------------------------------------------- 6. verify

// A successful execute is not evidence that anything was pulled, so none of
// the above is trusted — the containers are asked directly.
//
// Deliberately not compared across hosts: image ids and digests. A fleet can
// legitimately mix architectures, and the same multi-arch tag then resolves
// to a different per-arch manifest on each host.
const problems: string[] = []
const deployed = await komodo.read('ListStacks', {})

for (const stack of stacks) {
	const services = (deployed.find((s: any) => s.name === stack.name)?.info?.services ?? []) as any[]

	for (const svc of services.filter((s) => s.image && ours(s.image))) {
		const want = `${imageRepo(svc.image)}:${version}`
		const where = `${stack.name}/${svc.service}`

		if (svc.image !== want) {
			problems.push(`${where}: on ${svc.image}, expected ${want}`)
			continue
		}

		let state: any
		try {
			const inspected: any = await komodo.read('InspectStackContainer', {
				stack: stack.name,
				service: svc.service,
			})
			state = (inspected.container ?? inspected).State ?? {}
		} catch (error) {
			problems.push(`${where}: not inspectable — ${error}`)
			continue
		}

		if (!state.Running) {
			problems.push(`${where}: image is correct but the container is not running`)
			continue
		}
		const age = Math.round((Date.now() - Date.parse(state.StartedAt)) / 1000)
		if (age > MAX_CONTAINER_AGE_SECONDS) {
			problems.push(`${where}: tagged ${version} but up for ${age}s — never recreated`)
			continue
		}
		console.log(`ok ${where} ${version} (up ${age}s)`)
	}
}

if (problems.length) {
	throw new Error(`release ${version} did not land cleanly:\n  ${problems.join('\n  ')}`)
}

console.log(`fleet is on ${version}`)
