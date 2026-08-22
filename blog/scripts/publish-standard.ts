import { allPosts } from '../src/posts'
import { site } from '../src/site'
import { standard, standardDocumentPath, standardPublicationUri, standardTimestamp } from '../src/standard'

interface PdsService {
	id: string
	type: string
	serviceEndpoint: string
}

interface DidDocument {
	service?: PdsService[]
}

interface Session {
	accessJwt: string
	did: string
}

async function readJson<T>(response: Response, action: string): Promise<T> {
	if (!response.ok) {
		throw new Error(`${action} failed (${response.status}): ${await response.text()}`)
	}

	return response.json() as Promise<T>
}

async function resolvePds(): Promise<string> {
	const document = await readJson<DidDocument>(
		await fetch(`https://plc.directory/${standard.did}`),
		`Resolving ${standard.did}`,
	)
	const pds = document.service?.find((service) => service.id === '#atproto_pds')

	if (pds?.type !== 'AtprotoPersonalDataServer') {
		throw new Error(`No PDS service found for ${standard.did}`)
	}

	return pds.serviceEndpoint.replace(/\/$/, '')
}

async function createSession(pds: string, password: string): Promise<Session> {
	return readJson<Session>(
		await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifier: process.env.STANDARD_HANDLE ?? 'wisp.place', password }),
		}),
		'Creating an AT Protocol session',
	)
}

async function putRecord(
	pds: string,
	accessJwt: string,
	collection: string,
	rkey: string,
	record: Record<string, unknown>,
): Promise<void> {
	await readJson(
		await fetch(`${pds}/xrpc/com.atproto.repo.putRecord`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessJwt}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ repo: standard.did, collection, rkey, record }),
		}),
		`Publishing ${collection}/${rkey}`,
	)
}

const password = process.env.STANDARD_APP_PASSWORD
if (!password) {
	throw new Error('Set STANDARD_APP_PASSWORD to a wisp.place app password before publishing Standard.site records.')
}

const pds = await resolvePds()
const session = await createSession(pds, password)
if (session.did !== standard.did) {
	throw new Error(`STANDARD_HANDLE authenticated as ${session.did}, expected ${standard.did}`)
}

await putRecord(pds, session.accessJwt, standard.publicationCollection, standard.publicationRkey, {
	$type: standard.publicationCollection,
	url: site.url,
	name: site.title,
	description: site.description,
	preferences: { showInDiscover: true },
})

const publishedPosts = allPosts.filter((post) => !post.draft)
for (const post of publishedPosts) {
	await putRecord(pds, session.accessJwt, standard.documentCollection, post.slug, {
		$type: standard.documentCollection,
		site: standardPublicationUri,
		path: standardDocumentPath(post.slug),
		title: post.title,
		description: post.description,
		publishedAt: standardTimestamp(post.date),
		...(post.updated && { updatedAt: standardTimestamp(post.updated) }),
		tags: post.tags,
	})
}

console.info(`Published ${publishedPosts.length} Standard.site documents to ${standardPublicationUri}`)
