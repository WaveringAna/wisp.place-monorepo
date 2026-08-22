import { postHref } from './posts'

/**
 * Identity and stable record keys for the blog's Standard.site publication.
 *
 * These keys deliberately do not change as posts are edited, so an AT-URI
 * remains a durable reference to its corresponding canonical web page.
 */
export const standard = {
	did: 'did:plc:7puq73yz2hkvbcpdhnsze2qw',
	publicationRkey: 'blog',
	publicationCollection: 'site.standard.publication',
	documentCollection: 'site.standard.document',
} as const

export const standardPublicationUri = `at://${standard.did}/${standard.publicationCollection}/${standard.publicationRkey}`

export function standardDocumentUri(slug: string): string {
	return `at://${standard.did}/${standard.documentCollection}/${slug}`
}

/** The Standard path is the blog's canonical, trailing-slash route. */
export function standardDocumentPath(slug: string): string {
	return postHref(slug)
}

/** Post dates are day-granular; publish their records at the start of that UTC day. */
export function standardTimestamp(date: string): string {
	return `${date}T00:00:00.000Z`
}
