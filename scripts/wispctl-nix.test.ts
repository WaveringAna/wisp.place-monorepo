import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('wispctl Nix distribution', () => {
	test('builds the current locked Rust workspace, not the retired Bun package', () => {
		const flake = read('flake.nix')
		const version = read('cli-rs/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1]
		expect(flake).toContain('pkgs.rustPlatform.buildRustPackage')
		expect(flake).toContain('builtins.fromTOML')
		expect(version).toMatch(/^\d+\.\d+\.\d+$/)
		expect(flake).toContain('version = workspace.workspace.package.version;')
		expect(flake).toContain('src = ./cli-rs;')
		expect(flake).toContain('lockFile = ./cli-rs/Cargo.lock;')
		expect(flake).toContain('cargoBuildFlags = [ "-p" "wispctl" ];')
		expect(flake).not.toContain('bun2nix')
		expect(flake).not.toContain('cli/bun.nix')
		expect(flake).toContain('packages.default = wispctl;')
		expect(flake).toContain('packages.wispctl = wispctl;')
		expect(flake).toContain('SSL_CERT_FILE = ')
		expect(flake).toContain('pkgs.cacert')
	})

	test('keeps only reachable locked flake inputs', () => {
		const lock = JSON.parse(read('flake.lock'))
		const reachable = new Set<string>()
		const visit = (name: string) => {
			if (reachable.has(name)) return
			reachable.add(name)
			const node = lock.nodes[name]
			expect(node).toBeDefined()
			for (const input of Object.values(node.inputs ?? {})) {
				// Array references follow another input rather than owning a node.
				if (typeof input === 'string') visit(input)
			}
		}
		visit(lock.root)
		expect([...reachable].sort()).toEqual(Object.keys(lock.nodes).sort())
		expect(lock.nodes[lock.nodes[lock.root].inputs.nixpkgs].locked.rev).toMatch(/^[a-f0-9]{40}$/)
		expect(JSON.stringify(lock)).not.toContain('bun2nix')
	})

	test('pins every Cargo git checkout with a real output hash', () => {
		const lock = Bun.TOML.parse(read('cli-rs/Cargo.lock')) as {
			package: { name: string; version: string; source?: string }[]
		}
		const hashes = new Map(
			[...read('flake.nix').matchAll(/"([^"]+)" = "(sha256-[A-Za-z0-9+/]{43}=)";/g)].map(([, name, hash]) => [
				name,
				hash,
			]),
		)
		const sources = new Set(lock.package.flatMap((pkg) => (pkg.source?.startsWith('git+') ? [pkg.source] : [])))
		for (const source of sources) {
			expect(source).toMatch(/#[a-f0-9]{40}$/)
			const crates = lock.package.filter((pkg) => pkg.source === source)
			expect(crates.some((pkg) => hashes.has(`${pkg.name}-${pkg.version}`))).toBe(true)
		}
		expect(read('flake.nix')).not.toContain('fakeHash')
		expect([...hashes.values()]).not.toContain(`sha256-${'A'.repeat(43)}=`)
	})

	test('checks the installed CLI before publishing, without rewriting the lock', () => {
		const workflow = read('.tangled/workflows/build-wispctl.yml')
		expect(workflow).toContain('--no-update-lock-file')
		expect(workflow).toContain('--all-systems --no-build')
		expect(workflow).toContain('./result/bin/wispctl --version')
		expect(workflow).toContain('./result/bin/wispctl --help')
		expect(workflow).toContain('TANGLED_PIPELINE_KIND:-')
		expect(workflow).toContain('TANGLED_REF_NAME:-')
		expect(workflow.indexOf('./result/bin/wispctl --version')).toBeLessThan(workflow.indexOf('cachix push'))
		const rustWorkflow = read('.tangled/workflows/build-wispctl-rs.yml')
		expect(rustWorkflow).not.toContain('still the shipped one')
		expect(rustWorkflow).toContain('  - cacert')
		expect(rustWorkflow).toContain('export SSL_CERT_FILE=')
		expect(rustWorkflow).toContain('test -r "$SSL_CERT_FILE"')
	})
})
