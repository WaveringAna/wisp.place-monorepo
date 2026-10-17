/**
 * The interface against in-memory fixtures, without postgres, OAuth or the model:
 *   bun apps/labeler/src/ui/dev.ts
 * PORT (default 3000), DEV_DELAY_MS delays every API answer, DEV_FAIL=1 fails every
 * write. Writes on @broken.test always fail. /logout signs out (the API then
 * answers 401) and the login form signs back in.
 */
import type { LabelRequest, QueueView, VerdictRequest } from '../moderation/types'
import { createFixtureStore, DEV_MODERATOR } from './fixtures'
import index from './index.html'
import login from './login.html'

const delay = Number(process.env.DEV_DELAY_MS ?? 0)
const failAll = process.env.DEV_FAIL === '1'
const store = createFixtureStore()
let signedIn = true

const json = (body: unknown, status = 200) => Response.json(body, { status })
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })

function api(handler: (req: Request) => Response | Promise<Response>) {
	return async (req: Request) => {
		if (delay > 0) await Bun.sleep(delay)
		if (!signedIn) return json({ error: 'not signed in' }, 401)
		return handler(req)
	}
}

async function readWrite<T extends { uri: string }>(req: Request): Promise<T | Response> {
	if (!req.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'expected JSON' }, 415)
	const body = (await req.json()) as T
	if (failAll || store.failing(body.uri)) return json({ error: `fixture failure for ${body.uri}` }, 500)
	return body
}

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	development: true,
	routes: {
		'/': index,
		'/login': login,
		'/oauth/login': () => {
			signedIn = true
			return redirect('/')
		},
		'/logout': () => {
			signedIn = false
			return redirect('/login')
		},
		'/api/me': api(() => json(DEV_MODERATOR)),
		'/api/queue': api((req) => {
			const params = new URL(req.url).searchParams
			const view = (params.get('view') ?? 'flagged') as QueueView
			const limit = Math.min(Number(params.get('limit') ?? 20) || 20, 100)
			return json(store.queue(view, params.get('cursor'), limit))
		}),
		'/api/account/:did': api((req) => {
			const did = decodeURIComponent(new URL(req.url).pathname.slice('/api/account/'.length))
			const account = store.account(did)
			return account ? json(account) : json({ error: 'unknown account' }, 404)
		}),
		'/api/search': api((req) => json(store.search(new URL(req.url).searchParams.get('q') ?? ''))),
		'/api/events': api((req) => json(store.events(new URL(req.url).searchParams.get('cursor')))),
		'/api/verdict': {
			POST: api(async (req) => {
				const body = await readWrite<VerdictRequest>(req)
				if (body instanceof Response) return body
				const result = store.verdict(body, DEV_MODERATOR.did)
				return result ? json(result) : json({ error: 'bad verdict request' }, 400)
			}),
		},
		'/api/label': {
			POST: api(async (req) => {
				const body = await readWrite<LabelRequest>(req)
				if (body instanceof Response) return body
				const result = store.label(body, DEV_MODERATOR.did)
				return result ? json(result) : json({ error: 'bad label request' }, 400)
			}),
		},
	},
	fetch: () => json({ error: 'not found' }, 404),
})

console.log(
	`moderation ui (fixtures) on ${server.url}${delay ? ` delay ${delay}ms` : ''}${failAll ? ' writes fail' : ''}`,
)
