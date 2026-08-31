/**
 * The post index.
 *
 * Posts themselves are plain .astro pages under src/pages/posts/<slug>.astro —
 * write whatever HTML, CSS and JS you like in them. This file holds only the
 * metadata the listing page, RSS feed and post chrome need, so there is exactly
 * one place to look when you want to know what has been published.
 *
 * To add a post:
 *   1. Add an entry here (newest first is not required — they get sorted).
 *   2. Create src/pages/posts/<slug>.astro and wrap it in the Post layout:
 *        <Post slug="<slug>"> ...your HTML... </Post>
 *
 * The build fails loudly if a page references a slug that is not listed here.
 */

export interface Author {
	name: string
	/** Shown under the post title, e.g. an AT Protocol handle. */
	handle?: string
	url?: string
}

export interface Post {
	slug: string
	title: string
	/** One or two sentences. Used on the index, in RSS, and as the meta description. */
	description: string
	/** ISO date, YYYY-MM-DD. */
	date: string
	/** ISO date. Set when a published post gets a meaningful revision. */
	updated?: string
	author: Author
	tags: string[]
	/** Drafts are visible in `astro dev` but excluded from production builds. */
	draft?: boolean
}

export const authors = {
	nekomimi: {
		name: 'nekomimi',
		handle: '@nekomimi.pet',
		url: 'https://bsky.app/profile/nekomimi.pet',
	},
} satisfies Record<string, Author>

const posts: Post[] = [
	{
		slug: 'wispctl-1-3-2',
		title: 'wispctl 1.3.2',
		description: 'wispctl uses permission sets now for friendlier oauth links',
		date: '2026-08-29',
		author: authors.nekomimi,
		tags: ['release', 'cli'],
	},
	{
		slug: 'wispctl-1-3-1',
		title: 'wispctl 1.3.1',
		description: "Making wispctl's auth more ergonomic to use",
		date: '2026-08-26',
		author: authors.nekomimi,
		tags: ['release', 'cli'],
	},
	{
		slug: 'hello-world',
		title: 'wisp.place has a blog now',
		description:
			'Somewhere to put release notes, architecture write-ups and the occasional postmortem — instead of burying them in commit messages.',
		date: '2026-08-07',
		author: authors.nekomimi,
		tags: ['announcement'],
	},
	{
		slug: 'style-guide',
		title: 'Writing a post',
		description:
			'A kitchen-sink reference for every component and prose style available to a post. Kept as a permanent draft.',
		date: '2026-08-07',
		author: authors.nekomimi,
		tags: ['meta'],
		draft: true,
	},
	{
		slug: 'private-sites',
		title: 'New and future: private sites, permissioned data, and open web realities.',
		description: 'The announcement of private sites and detailing upcoming quota systems when permissioned data lands',
		date: '2026-08-22',
		author: authors.nekomimi,
		tags: ['announcement'],
	},
]

/** True in `astro build`, false in `astro dev`. */
const isProduction = import.meta.env.PROD

/** Every post that should be listed, newest first. Drafts are dev-only. */
export const allPosts: Post[] = posts
	.filter((post) => !post.draft || !isProduction)
	.sort((a, b) => b.date.localeCompare(a.date))

/** Every tag in use, ordered by how often it appears. */
export const allTags: string[] = [...new Set(allPosts.flatMap((p) => p.tags))].sort((a, b) => {
	const count = (tag: string) => allPosts.filter((p) => p.tags.includes(tag)).length
	return count(b) - count(a) || a.localeCompare(b)
})

export function postHref(slug: string): string {
	return `/posts/${slug}/`
}

/** Looks up a post by slug. Throws at build time if the slug is unknown. */
export function getPost(slug: string): Post {
	const post = posts.find((p) => p.slug === slug)
	if (!post) {
		throw new Error(`Unknown post slug "${slug}". Add it to blog/src/posts.ts before using it in a page.`)
	}
	return post
}

/** Previous (older) and next (newer) published posts, for the post footer. */
export function neighbours(slug: string): { previous?: Post; next?: Post } {
	const index = allPosts.findIndex((p) => p.slug === slug)
	if (index === -1) return {}
	return { previous: allPosts[index + 1], next: allPosts[index - 1] }
}
