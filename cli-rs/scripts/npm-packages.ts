#!/usr/bin/env bun
// Stage the wispctl npm packages from the release binaries in ./binaries
// (scripts/build-cli-binaries.sh): one package per platform holding its native
// binary, plus `wispctl`, a node shim that depends on all of them optionally.
//
// usage (from the repo root): bun cli-rs/scripts/npm-packages.ts
// then publish every platform package before `wispctl` itself.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const out = join(root, 'cli-rs/target/npm')
const version = readFileSync(join(root, 'cli-rs/Cargo.toml'), 'utf8').match(/^version = "(.+)"$/m)?.[1]
if (!version) throw new Error('no workspace version in cli-rs/Cargo.toml')

const platforms = [
	{ os: 'darwin', cpu: 'arm64', binary: 'wisp-cli-aarch64-darwin' },
	{ os: 'darwin', cpu: 'x64', binary: 'wisp-cli-x86_64-darwin' },
	{ os: 'linux', cpu: 'x64', binary: 'wisp-cli-x86_64-linux' },
	{ os: 'linux', cpu: 'arm64', binary: 'wisp-cli-aarch64-linux' },
	{ os: 'win32', cpu: 'x64', binary: 'wisp-cli-x86_64-windows.exe' },
].map((p) => ({ ...p, name: `@wispplace/wispctl-${p.os}-${p.cpu}`, exe: p.os === 'win32' ? 'wispctl.exe' : 'wispctl' }))

// Catch a version bump without a rebuild: the binary for this machine must
// report the version being published.
const host = platforms.find((p) => p.os === process.platform && p.cpu === process.arch)
if (host) {
	const built = spawnSync(join(root, 'binaries', host.binary), ['--version'], { encoding: 'utf8' }).stdout?.trim()
	if (built !== version) throw new Error(`binaries/${host.binary} is ${built}, not ${version}: rebuild first`)
}

const shared = {
	version,
	license: 'MIT',
	homepage: 'https://docs.wisp.place/cli/',
	repository: { type: 'git', url: 'git+https://github.com/WaveringAna/wisp.place-monorepo.git', directory: 'cli-rs' },
}

const writePackage = (dir: string, manifest: object) => {
	mkdirSync(join(dir, 'bin'), { recursive: true })
	writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, '\t')}\n`)
}

rmSync(out, { recursive: true, force: true })

for (const p of platforms) {
	const dir = join(out, `wispctl-${p.os}-${p.cpu}`)
	writePackage(dir, {
		name: p.name,
		description: `The ${p.os} ${p.cpu} binary for wispctl`,
		...shared,
		os: [p.os],
		cpu: [p.cpu],
		files: [`bin/${p.exe}`],
		publishConfig: { access: 'public' },
	})
	copyFileSync(join(root, 'binaries', p.binary), join(dir, 'bin', p.exe))
	chmodSync(join(dir, 'bin', p.exe), 0o755)
}

const main = join(out, 'wispctl')
writePackage(main, {
	name: 'wispctl',
	description: 'CLI for wisp.place - deploy static sites to the AT Protocol',
	...shared,
	bin: { wispctl: 'bin/wispctl.js' },
	files: ['bin/wispctl.js'],
	engines: { node: '>=18' },
	optionalDependencies: Object.fromEntries(platforms.map((p) => [p.name, version])),
})
copyFileSync(join(root, 'cli-rs/npm/wispctl.js'), join(main, 'bin/wispctl.js'))
copyFileSync(join(root, 'cli-rs/npm/README.md'), join(main, 'README.md'))

console.log(`staged wispctl ${version} and ${platforms.length} platform packages in ${out}`)
