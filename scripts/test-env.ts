/**
 * Test preload: stop a developer's local `.env` from deciding test results.
 *
 * Bun loads `.env` from the working directory before the test process starts,
 * so a developer with BASE_HOST, REDIS_URL or S3_BUCKET set locally ran a
 * materially different build of the code than CI does. That produced failures
 * that were real on one machine and un-reproducible on another — the two this
 * file exists to prevent were `PRIVATE_HOST` flipping a 404's reason, and
 * `REDIS_URL` flipping /health from 200 to 503.
 *
 * This runs before any test module is imported (see the `preload` key in
 * bunfig.toml) and clears the variables that select hosts, origins, or backing
 * infrastructure. Tests that need one set it itself, explicitly, which is also
 * what makes the failure mode obvious at the call site.
 *
 * Silent by default: `bun test --isolate` gives every test file its own process,
 * so an unconditional note here would print once per file and bury the results.
 * Set WISP_TEST_ENV_REPORT=1 to see what was cleared.
 */

const LEAKED_VARS = [
	// Host routing. Read at module scope in hosting-service/src/server.ts.
	'BASE_HOST',
	'PRIVATE_HOST',
	'PREVIEW_HOST',
	// Backing infrastructure. Presence alone flips readiness and storage mode.
	'REDIS_URL',
	'S3_BUCKET',
	'PRIVATE_S3_BUCKET',
	'S3_REGION',
	'S3_ENDPOINT',
	'S3_FORCE_PATH_STYLE',
	// Origins.
	'MAIN_APP_URL',
	'BASE_DOMAIN',
] as const

const stripped: string[] = []

for (const name of LEAKED_VARS) {
	const value = process.env[name]
	// An empty string is already the "not configured" answer, so only a value
	// that would actually change behaviour is worth reporting.
	if (value === undefined || value === '') continue
	process.env[name] = ''
	stripped.push(`${name}=${value.length > 24 ? `${value.slice(0, 24)}…` : value}`)
}

if (stripped.length > 0 && process.env.WISP_TEST_ENV_REPORT) {
	process.stderr.write(`[test-env] cleared local .env values before tests: ${stripped.join(', ')}\n`)
}
