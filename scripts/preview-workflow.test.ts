import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const guide = await readFile(new URL('../docs/src/content/docs/guides/preview-deploys.md', import.meta.url), 'utf8')
const workflows = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
	(match) => Bun.YAML.parse(match[1]!) as { steps: { name: string; command: string }[] },
)
const deploy = workflows[0]!.steps.find((step) => step.name === 'deploy preview')!.command
const prune = workflows[1]!.steps[0]!.command

const exercise = async (command: string, supported = true, secret = 'fixture-password') => {
	const dir = await mkdtemp(join(tmpdir(), 'wisp-preview-workflow-'))
	try {
		const npm = join(dir, 'npm')
		await writeFile(
			npm,
			`#!/bin/bash
set -eu
[ "$1" = install ] && [ "$2" = --global ] && [ "$3" = --prefix ]
[ "$4" = "$HOME/.local" ] && [ "$5" = wispctl@2.0.2 ]
mkdir -p "$4/bin"
cp "$FAKE_CLI" "$4/bin/wispctl"
`,
		)
		const cli = join(dir, 'fixture-wispctl')
		await writeFile(
			cli,
			`#!/bin/bash
set -eu
if [ "\${2:-}" = --help ]; then
  ${supported ? "echo '--header --preview-host'" : "echo '--path --site'"}
  exit 0
fi
printf '%s\n' "$*" >> "$HOME/invocations"
`,
		)
		const curl = join(dir, 'curl')
		await writeFile(curl, '#!/bin/bash\nexit 0\n')
		await Promise.all([npm, cli, curl].map((path) => chmod(path, 0o755)))
		const child = Bun.spawn(['/bin/bash', '-c', command], {
			env: {
				HOME: dir,
				PATH: `${dir}:/usr/bin:/bin`,
				FAKE_CLI: cli,
				WISP_APP_PASSWORD: secret,
				WISP_HANDLE: 'fixture.test',
				PREVIEW_HOST: 'preview.example',
				PREVIEW_CLAIM: 'fixture',
				TANGLED_COMMIT_SHA: 'abc123456789',
				TANGLED_PIPELINE_ID: 'at://did:plc:fixture/sh.tangled.pipeline/fixture',
				TANGLED_REPO_DID: 'did:plc:fixture',
				TANGLED_REPO_NAME: 'fixture',
			},
			stdout: 'ignore',
			stderr: 'pipe',
		})
		const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
		const invocations = await readFile(join(dir, 'invocations'), 'utf8').catch(() => '')
		return { exit, stderr, invocations }
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

describe('preview workflow installation', () => {
	test('deploy installs outside the read-only Nix store and preserves preview flags', async () => {
		const result = await exercise(deploy)
		expect(result.exit).toBe(0)
		expect(result.invocations).toContain('--preview-host preview.example')
		expect(result.invocations).toContain('--preview-claim fixture')
		expect(result.invocations).toContain('--header X-Robots-Tag: noindex')
		expect(result.invocations).toContain('--site pr-abc1234')
	})
	test('unsupported published CLI fails before uploading', async () => {
		const result = await exercise(deploy, false)
		expect(result.exit).not.toBe(0)
		expect(result.stderr).toContain('preview')
		expect(result.invocations).toBe('')
	})
	test('fork without a secret skips before installation', async () => {
		const result = await exercise(deploy, true, '')
		expect(result.exit).toBe(0)
		expect(result.invocations).toBe('')
	})
	test('prune installs into the same writable prefix', async () => {
		const result = await exercise(prune)
		expect(result.exit).toBe(0)
		expect(result.invocations).toContain('site prune fixture.test')
	})
})
