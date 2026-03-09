#!/usr/bin/env bun

const result = await Bun.build({
	entrypoints: ['./src/index.ts'],
	outdir: './dist',
	target: 'bun',
	format: 'esm',
	minify: process.env.NODE_ENV === 'production',
	sourcemap: 'external',
	splitting: false,
})

if (!result.success) {
	console.error('Build failed:')
	for (const log of result.logs) {
		console.error(log)
	}
	process.exit(1)
}

console.log('✅ Build successful!')
console.log(`📦 Generated ${result.outputs.length} file(s):`)
for (const output of result.outputs) {
	console.log(`   - ${output.path}`)
}
