// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://blog.wisp.place',
	build: {
		// Trailing-slash directories keep URLs stable if a post is ever renamed
		// behind a redirect, and match how the docs site is served.
		format: 'directory',
	},
});
// Posts are hand-written .astro pages, so there is no markdown pipeline to
// configure — syntax highlighting is set per-block in components/CodeBlock.astro.
