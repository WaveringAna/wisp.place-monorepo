#!/usr/bin/env bun

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { css as wispCss } from '@wispplace/css'

const distDir = `${import.meta.dir}/dist`
const publicDir = `${import.meta.dir}/public`
const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production'

await rm(distDir, { recursive: true, force: true })
await mkdir(`${distDir}/editor`, { recursive: true })

const editorResult = await Bun.build({
	entrypoints: [`${publicDir}/editor/editor.tsx`],
	outdir: `${distDir}/editor`,
	target: 'browser',
	format: 'esm',
	minify: true,
	sourcemap: 'none',
	splitting: true,
	// Without this React ships its development build, warnings and all.
	define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
	naming: {
		entry: '[name].[hash].js',
		chunk: '[name].[hash].js',
		asset: '[name].[hash][ext]',
	},
})

if (!editorResult.success) {
	console.error('editor build failed:')
	for (const log of editorResult.logs) console.error(log)
	process.exit(1)
}

const editorBundle = editorResult.outputs.find((output) => output.kind === 'entry-point')
if (!editorBundle) {
	console.error('editor build produced no entry bundle')
	process.exit(1)
}
const editorBundleName = path.basename(editorBundle.path)

const htmlContent = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>dashboard · wisp.place</title>
		<meta name="description" content="Manage your sites, domains and webhooks on wisp.place." />
		<meta name="robots" content="noindex" />
		<meta name="theme-color" content="#fbf3ec" media="(prefers-color-scheme: light)" />
		<meta name="theme-color" content="#1c1830" media="(prefers-color-scheme: dark)" />
		<script>
			try {
				const theme = localStorage.getItem('wisp-theme')
				if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
			} catch {}
		</script>

		<link rel="icon" type="image/x-icon" href="/favicon.ico">
		<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
		<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
		<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
		<link rel="manifest" href="/site.webmanifest">

		<link rel="preconnect" href="https://fonts.googleapis.com">
		<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
		<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&family=Fraunces:opsz,wght,SOFT,WONK@9..144,700,100,1&family=JetBrains+Mono:wght@400;500;700&display=swap">
		<link rel="stylesheet" href="/dist/styles.css">
	</head>
	<body>
		<div id="app"></div>
		<script type="module" src="/editor/${editorBundleName}"></script>
	</body>
</html>
`

await Bun.write(`${distDir}/editor/index.html`, htmlContent)

// The landing and legal pages link /wisp.css, which the static plugin serves from public/.
await Bun.write(`${publicDir}/wisp.css`, wispCss)

console.log(`built the ${mode} dashboard:`)
for (const file of [
	`${distDir}/editor/index.html`,
	...editorResult.outputs.map((output) => output.path),
	`${publicDir}/wisp.css`,
]) {
	console.log(`  ${path.relative(import.meta.dir, file)}`)
}
