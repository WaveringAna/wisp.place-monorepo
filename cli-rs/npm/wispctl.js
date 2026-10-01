#!/usr/bin/env node
// npm installs exactly one @wispplace/wispctl-<platform> package next to this
// one (os/cpu-gated optional dependencies); this shim runs its native binary.
const { spawnSync } = require('node:child_process')

const target = `${process.platform}-${process.arch}`
const exe = process.platform === 'win32' ? 'wispctl.exe' : 'wispctl'

const binary = (() => {
	try {
		return require.resolve(`@wispplace/wispctl-${target}/bin/${exe}`)
	} catch {
		console.error(
			`wispctl: no prebuilt binary for ${target}.\n` +
				'Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64.\n' +
				'If yours is listed, reinstall without --omit=optional (or --no-optional),\n' +
				'or download a binary from https://docs.wisp.place/cli/',
		)
		process.exit(1)
	}
})()

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' })
if (result.error) {
	console.error(`wispctl: ${result.error.message}`)
	process.exit(1)
}
if (result.signal) process.kill(process.pid, result.signal)
process.exit(result.status ?? 1)
