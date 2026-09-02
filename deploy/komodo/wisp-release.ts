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

const [major, minor, patch] = version.split('.').map(Number)

if (!/^\d+\.\d+\.\d+$/.test(version)) {
	throw new Error(`bad version arg: '${version}' (want major.minor.patch)`)
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
	throw new Error(`bad commit arg: '${commit}' (want a full 40-char sha)`)
}
if (!repo) {
	throw new Error('missing repo arg (the source repo the builds clone)')
}

// Komodo stores a build version as a struct, not a string.
const semver: Types.Version = { major, minor, patch }

// ---------------------------------------------------------------- helpers

// Strip the tag from an image reference, leaving the repository path.
// A colon only introduces a tag when it sits in the last path segment.
const imageRepo = (ref: string): string => {
	const slash = ref.lastIndexOf('/')
	const colon = ref.lastIndexOf(':')
	return colon > slash ? ref.slice(0, colon) : ref
}

// Komodo types these as optional, and they genuinely can be absent — a
// resource can exist without a readable config. Failing here names the
// resource; letting it through produces an "undefined is not an object"
// halfway into a deploy.
const required = <T>(value: T | null | undefined, what: string): T => {
	if (value === null || value === undefined) {
		throw new Error(`Komodo returned no ${what}`)
	}
	return value
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

// `komodo.execute(...)` DOES NOT WAIT. It returns the Update record in its
// initial state — `success: true, status: "InProgress"` — before the work
// has begun, so reading `.success` off it is meaningless: a whole release
// will "succeed" in ten seconds having built and deployed nothing.
//
// `execute_and_poll` is the client's own version that waits for the Update
// to reach Complete. Use it for anything whose result matters. It can also
// return a batch array, which none of the calls here do — `one()` narrows
// that away rather than leaving the union to be indexed blindly.
const one = (result: Awaited<ReturnType<typeof komodo.execute_and_poll>>): Types.Update => {
	if (Array.isArray(result)) {
		throw new Error('expected a single update, got a batch result')
	}
	return result
}

// An Update's id is `_id.$oid`, not `.id`. Getting this wrong prints
// "undefined" into exactly the error that is supposed to point at the run.
const updateRef = (update: Types.Update): string => update._id?.$oid ?? 'unknown'

// The server terminal is a live bash session: it appends its exit-code
// marker to the LAST LINE sent, echoes the prompt between lines, and hangs
// forever if a line leaves bash awaiting input. So a script goes over as
// exactly one line, base64-encoded into a fresh non-interactive bash, and
// the marker then reflects that bash's status.
const sh = async (server: string, script: string): Promise<string> => {
	const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(script)))
	const lines: string[] = []
	let code: string | undefined
	await komodo.execute_server_terminal(
		{ server, command: `printf %s '${encoded}' | base64 -d | bash`, init: { command: 'bash' } },
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
	if (code !== '0') {
		throw new Error(`[${server}] exit ${code ?? '?'}\n${out}`)
	}
	return out
}

// ------------------------------------------- 1. discover what we build

const builds = (await komodo.read('ListBuilds', {})).filter((b) => b.info?.repo === repo)

if (!builds.length) {
	throw new Error(`no Komodo build clones '${repo}' — nothing to release`)
}

// The fully-qualified image each build pushes, so stacks can be matched by
// what they actually run rather than by name.
const images: string[] = []

for (const build of builds) {
	const config = required(
		(await komodo.read('GetBuild', { build: build.name })).config,
		`config for build ${build.name}`,
	)
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
		config: { version: semver, auto_increment_version: false, commit },
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
		const update = one(await komodo.execute_and_poll('RunBuild', { build: build.name }))
		ok = update.success
		if (!ok) {
			console.log(`build ${build.name} failed (attempt ${attempt}/2), update ${updateRef(update)}`)
			if (attempt === 2) {
				throw new Error(`build ${build.name} failed twice — see Komodo update ${updateRef(update)}`)
			}
		}
	}
	console.log(`built ${build.name}:${version}`)
}

// -------------------------------------- 4. find the stacks that run them

const ours = (image: string) => images.includes(imageRepo(image))

const stacks = (await komodo.read('ListStacks', {})).filter((s) =>
	(s.info?.services ?? []).some((svc) => svc.image && ours(svc.image)),
)

if (!stacks.length) {
	throw new Error(`built ${version} but no stack runs any of: ${images.join(', ')}`)
}

// ---------------------------------------------------------- 5. deploy

// The tag moves through the stack's own environment, which Komodo owns and
// writes out at deploy time. Compose files are hand-maintained and carry
// per-host detail this release knows nothing about, so nothing here renders,
// templates or rewrites one.
// What each service was on before this deploy, so verification can tell
// "already correct, nothing to do" apart from "never actually deployed".
const before = new Map<string, string>()
for (const stack of stacks) {
	for (const svc of stack.info?.services ?? []) {
		if (svc.image && ours(svc.image)) before.set(`${stack.name}/${svc.service}`, svc.image)
	}
}

for (const stack of stacks) {
	const config = required(
		(await komodo.read('GetStack', { stack: stack.name })).config,
		`config for stack ${stack.name}`,
	)
	await komodo.write('UpdateStack', {
		id: stack.name,
		config: { environment: withVar(config.environment ?? '', TAG_VAR, version) },
	})

	// Pull explicitly, on the host, before deploying.
	//
	// Compose cannot be relied on to fetch these: some services carry
	// `pull_policy: never` from before images came from a registry, so
	// `compose up` skips the pull and then dies with a bare
	// "No such image" that names no cause. Pulling here means a registry or
	// credential problem surfaces as a registry error, on the host that has
	// the problem, before anything is torn down.
	const wanted = [
		...new Set(
			(stack.info?.services ?? [])
				.map((s) => s.image)
				.filter((i: string) => i && ours(i))
				.map((i: string) => `${imageRepo(i)}:${version}`),
		),
	]

	const pull = [
		'set -euo pipefail',
		...wanted.map((image) => `echo "pulling ${image}"; docker pull -q '${image}' >/dev/null`),
	].join('\n')

	const server = required(stack.info?.server_name, `server for stack ${stack.name}`)
	await sh(server, pull)
	console.log(`pulled ${wanted.length} images on ${server}`)

	const update = one(await komodo.execute_and_poll('DeployStack', { stack: stack.name }))
	if (!update.success) {
		throw new Error(`DeployStack ${stack.name} failed — see Komodo update ${updateRef(update)}`)
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
	const services = deployed.find((s) => s.name === stack.name)?.info?.services ?? []

	for (const svc of services.filter((s) => s.image && ours(s.image))) {
		const want = `${imageRepo(svc.image)}:${version}`
		const where = `${stack.name}/${svc.service}`

		// The image is read off the container, not off the stack listing.
		// Komodo's listing reports a *rendered* image, and when it renders
		// without the stack's env file the tag interpolates to nothing and
		// surfaces as ":0" — a healthy service then looks like a failed
		// deploy. The container knows what it is actually running.
		let container: Types.InspectStackContainerResponse
		try {
			container = await komodo.read('InspectStackContainer', {
				stack: stack.name,
				service: svc.service,
			})
		} catch (error) {
			problems.push(`${where}: not inspectable — ${error}`)
			continue
		}

		const state = container.State ?? {}
		const running = container.Config?.Image

		if (running !== want) {
			problems.push(`${where}: on ${running}, expected ${want}`)
			continue
		}
		if (!state.Running) {
			problems.push(`${where}: image is correct but the container is not running`)
			continue
		}
		// Only demand a recent restart where the tag actually moved. Re-running
		// a release that is already live is legitimate and recreates nothing,
		// so an old uptime there is correct rather than suspicious.
		const startedAt = state.StartedAt
		if (!startedAt) {
			problems.push(`${where}: container reports no start time`)
			continue
		}
		const age = Math.round((Date.now() - Date.parse(startedAt)) / 1000)
		const was = before.get(where)
		// A pre-deploy image the listing could not render (":0" or a bare
		// ":") says nothing about whether this moved, so the age check is
		// skipped rather than failed on a guess.
		const knownBefore = was && !/:(0)?$/.test(was)
		const moved = knownBefore && was !== want
		if (moved && age > MAX_CONTAINER_AGE_SECONDS) {
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
