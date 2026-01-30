#!/usr/bin/env bun

import { rm, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

console.log('🔨 Building main-app frontend...')

// Get the directory where this script is located
const scriptDir = import.meta.dir

const distDir = `${scriptDir}/dist`
const publicDir = `${scriptDir}/public`

// Clean dist directory
if (existsSync(distDir)) {
	await rm(distDir, { recursive: true })
}
await mkdir(distDir, { recursive: true })
await mkdir(`${distDir}/editor`, { recursive: true })

// Build the editor React app
const editorResult = await Bun.build({
	entrypoints: [`${publicDir}/editor/editor.tsx`],
	outdir: `${distDir}/editor`,
	target: 'browser',
	format: 'esm',
	minify: true,
	sourcemap: 'none',
	splitting: true,
	naming: {
		entry: '[name].[hash].js',
		chunk: '[name].[hash].js',
		asset: '[name].[hash][ext]'
	}
})

if (!editorResult.success) {
	console.error('❌ Editor build failed:')
	for (const log of editorResult.logs) {
		console.error(log)
	}
	process.exit(1)
}

// Find the main entry bundle
const editorBundle = editorResult.outputs.find(o => o.path.includes('editor.') && o.path.endsWith('.js'))

if (!editorBundle) {
	console.error('❌ Could not find editor bundle in outputs')
	process.exit(1)
}

const editorBundleName = path.basename(editorBundle.path)

// Generate the production HTML
const htmlContent = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>wisp.place</title>
		<meta name="description" content="Manage your decentralized static sites hosted on AT Protocol." />

		<!-- Open Graph / Facebook -->
		<meta property="og:type" content="website" />
		<meta property="og:url" content="https://wisp.place/editor" />
		<meta property="og:title" content="Editor - wisp.place" />
		<meta property="og:description" content="Manage your decentralized static sites hosted on AT Protocol." />
		<meta property="og:site_name" content="wisp.place" />

		<!-- Twitter -->
		<meta name="twitter:card" content="summary" />
		<meta name="twitter:url" content="https://wisp.place/editor" />
		<meta name="twitter:title" content="Editor - wisp.place" />
		<meta name="twitter:description" content="Manage your decentralized static sites hosted on AT Protocol." />

		<!-- Theme -->
		<meta name="theme-color" content="#7c3aed" />

		<link rel="icon" type="image/x-icon" href="/favicon.ico">
		<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
		<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
		<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
		<link rel="manifest" href="/site.webmanifest">
		<link rel="stylesheet" href="/dist/styles.css">
		<style>
			/* Dark theme fallback styles for before JS loads */
			@media (prefers-color-scheme: dark) {
				body {
					background-color: oklch(0.23 0.015 285);
					color: oklch(0.90 0.005 285);
				}

				pre {
					background-color: oklch(0.33 0.015 285) !important;
					color: oklch(0.90 0.005 285) !important;
				}

				.bg-muted {
					background-color: oklch(0.33 0.015 285) !important;
				}
			}
		</style>
	</head>
	<body>
		<div id="elysia"></div>
		<script type="module" src="/editor/${editorBundleName}"></script>
	</body>
</html>
`

await Bun.write(`${distDir}/editor/index.html`, htmlContent)

console.log('✅ Build successful!')
console.log(`📦 Generated ${editorResult.outputs.length + 1} file(s):`)
console.log(`   - ${distDir}/editor/index.html`)
for (const output of editorResult.outputs) {
	console.log(`   - ${output.path}`)
}
