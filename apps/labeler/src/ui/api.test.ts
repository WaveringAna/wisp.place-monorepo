import { expect, test } from 'bun:test'
import { ApiFailure, createApi } from './api'

function fakeFetch(respond: (url: string, init?: RequestInit) => Response) {
	const calls: { url: string; init?: RequestInit }[] = []
	const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init })
		return respond(String(input), init)
	}) as typeof fetch
	return { fn, calls }
}

test('builds query strings without empty params and posts JSON', async () => {
	const { fn, calls } = fakeFetch(() => Response.json({ items: [], cursor: null, counts: {}, site: null }))
	const api = createApi(fn, () => {})
	await api.queue('flagged', null, 20)
	await api.queue('recent', 'c1', 20)
	await api.verdict({ uri: 'did:plc:x', verdict: 'spam' })
	expect(calls.map((c) => c.url)).toEqual([
		'/api/queue?view=flagged&limit=20',
		'/api/queue?view=recent&cursor=c1&limit=20',
		'/api/verdict',
	])
	expect(calls[2]!.init?.method).toBe('POST')
	expect(new Headers(calls[2]!.init?.headers).get('content-type')).toBe('application/json')
	expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ uri: 'did:plc:x', verdict: 'spam' })
})

test('a 401 signs out and an error body becomes the message', async () => {
	let signedOut = 0
	const { fn } = fakeFetch((url) =>
		url === '/api/me' ? new Response('', { status: 401 }) : Response.json({ error: 'no such site' }, { status: 404 }),
	)
	const api = createApi(fn, () => signedOut++)
	await expect(api.me()).rejects.toBeInstanceOf(ApiFailure)
	expect(signedOut).toBe(1)
	await expect(api.account('did:plc:x')).rejects.toThrow('no such site')
	expect(signedOut).toBe(1)
})
