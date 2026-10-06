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

// The CI runner is NixOS: no /bin/bash, and /usr/bin holds only env.
const bash = Bun.which('bash') ?? 'bash'

const exercise = async (command: string, secret = 'fixture-password') => {
	const dir = await mkdtemp(join(tmpdir(), 'wisp-preview-workflow-'))
	try {
		const npm = join(dir, 'npm')
		await writeFile(
			npm,
			`#!/usr/bin/env bash
set -eu
[ "$1" = install ] && [ "$2" = --global ] && [ "$3" = --prefix ]
[ "$4" = "$HOME/.local" ] && [ "$5" = wispctl@2.1.0 ]
mkdir -p "$4/bin"
cp "$FAKE_CLI" "$4/bin/wispctl"
`,
		)
		const cli = join(dir, 'fixture-wispctl')
		await writeFile(
			cli,
			`#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$HOME/invocations"
`,
		)
		await Promise.all([npm, cli].map((path) => chmod(path, 0o755)))
		const child = Bun.spawn([bash, '-c', command], {
			env: {
				HOME: dir,
				PATH: `${dir}:${process.env.PATH}`,
				FAKE_CLI: cli,
				WISP_APP_PASSWORD: secret,
				WISP_HANDLE: 'fixture.test',
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
	test('deploy installs outside the read-only Nix store and leaves the rest to preview deploy', async () => {
		const result = await exercise(deploy)
		expect(result.exit).toBe(0)
		expect(result.invocations).toBe('preview deploy --path ./dist\n')
	})
	test('prune installs into the same writable prefix', async () => {
		const result = await exercise(prune)
		expect(result.exit).toBe(0)
		expect(result.invocations).toContain('site prune fixture.test')
	})
})
