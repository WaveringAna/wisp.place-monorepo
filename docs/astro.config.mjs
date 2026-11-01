// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import { render } from 'pele';

const renderMermaid = (node) => {
	if (node.type === 'code' && node.lang === 'mermaid') {
		Object.assign(node, { type: 'html', value: render(node.value).svg });
	}
	node.children?.forEach(renderMermaid);
};
const remarkMermaid = () => renderMermaid;

// https://astro.build/config
export default defineConfig({
	markdown: { remarkPlugins: [remarkMermaid] },
	integrations: [
		starlight({
			title: 'Wisp.place Docs',
			components: {
				SocialIcons: './src/components/SocialIcons.astro',
				PageFrame: './src/components/PageFrame.astro',
				Head: './src/components/Head.astro',
			},
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
					items: [{ autogenerate: { directory: 'lexicons' } }],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Private Sites', slug: 'private-sites' },
						{ label: 'Local Development', slug: 'local-development' },
						{ label: 'Architecture', slug: 'architecture' },
						{ label: 'Self-Hosting', slug: 'deployment' },
						{ label: 'Monitoring & Metrics', slug: 'monitoring' },
						{ label: 'Redirects & Rewrites', slug: 'redirects' },
						{ label: 'Blob Reuse & Framework Caveats', slug: 'guides/blob-reuse' },
						{ label: 'Preview Deploys', slug: 'guides/preview-deploys' },
						{ label: 'Static PDSes', slug: 'guides/static-pds' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'XRPC API', slug: 'reference/xrpc-api' },
						{ label: 'Main App API', slug: 'reference/main-app-api' },
						{ label: 'Being a supporter', slug: 'reference/supporters' },
					],
				},
			],
			customCss: ['./src/styles/custom.css'],
		}),
	],
});
