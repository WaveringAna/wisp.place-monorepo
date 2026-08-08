import type { APIRoute } from 'astro'
import { allPosts, postHref } from '../posts'
import { site, toRFC822 } from '../site'

/**
 * Hand-rolled RSS 2.0 so the blog stays dependency-free. Posts are hand-written
 * HTML pages rather than markdown, so the feed carries the description only —
 * readers follow the link for the full piece.
 */

const escapeXml = (value: string): string =>
	value.replace(
		/[<>&'"]/g,
		(char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char] ?? char,
	)

export const GET: APIRoute = () => {
	const items = allPosts
		.filter((post) => !post.draft)
		.map((post) => {
			const url = new URL(postHref(post.slug), site.url).href
			return `		<item>
			<title>${escapeXml(post.title)}</title>
			<link>${url}</link>
			<guid isPermaLink="true">${url}</guid>
			<pubDate>${toRFC822(post.date)}</pubDate>
			<description>${escapeXml(post.description)}</description>
			${post.tags.map((tag) => `<category>${escapeXml(tag)}</category>`).join('\n\t\t\t')}
		</item>`
		})
		.join('\n')

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
	<channel>
		<title>${escapeXml(site.title)}</title>
		<link>${site.url}</link>
		<description>${escapeXml(site.description)}</description>
		<language>${site.language}</language>
		<atom:link href="${site.url}/rss.xml" rel="self" type="application/rss+xml" />
${items}
	</channel>
</rss>
`

	return new Response(xml, {
		headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
	})
}
