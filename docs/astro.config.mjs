// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'Wisp.place Docs',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/tangled-org/wisp.place' }],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Overview', slug: 'index' },
						{ label: 'CLI Tool', slug: 'cli' },
					],
				},
				{
					label: 'Lexicons',
					autogenerate: { directory: 'lexicons' },
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Self-Hosting', slug: 'deployment' },
						{ label: 'Redirects & Rewrites', slug: 'redirects' },
					],
				},
			],
			customCss: ['./src/styles/custom.css'],
		}),
	],
});
