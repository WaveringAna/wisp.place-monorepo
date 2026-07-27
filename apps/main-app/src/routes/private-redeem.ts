import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { createLogger } from '@wispplace/observability'
import { PRIVATE_ACCESS_PAGE_STYLES } from '@wispplace/private-sites'
import { Elysia } from 'elysia'
import { openPrivateSiteForAccount, redeemScopedShare, resolveShareLink } from '../lib/private-sites-service'
import { authenticateRequest, SESSION_COOKIE_NAME } from '../lib/wisp-auth'

const logger = createLogger('main-app')
const json = (value: unknown): string =>
	JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} — wisp.place</title>
<style>${PRIVATE_ACCESS_PAGE_STYLES}</style></head>
<body><main class="private-page private-shell">${body}</main></body></html>`

const signInPage = (siteId: string, token?: string): string => {
	const shared = token !== undefined
	return page(
		'sign in',
		`<div class="private-brand"><strong>wisp.place</strong></div>
${shared ? '<p class="private-kicker">shared link</p>' : ''}
<h1>sign in to open this ${shared ? 'link' : 'private site'}</h1>
<p>${shared ? 'this private site was shared with a specific account.' : 'only accounts with access can open it without a share link.'}</p>
<form id="f" class="private-form">
 <label for="handle">your handle</label>
 <input type="text" id="handle" placeholder="alice.bsky.social" autocomplete="username" autocapitalize="none" autocorrect="off" required>
 <button class="private-action" id="action" type="submit" disabled>sign in to continue <span aria-hidden="true">→</span></button>
 <p class="private-error" id="err" aria-live="polite"></p>
</form>
<p class="private-note">your password stays with your personal data server. wisp only starts the sign-in handoff.</p>
<script>
 var payload = ${json({ siteId, token })}
 var form = document.getElementById('f'), input = document.getElementById('handle'), action = document.getElementById('action'), error = document.getElementById('err')
 function sync() { action.disabled = !input.value.trim() || action.getAttribute('aria-busy') === 'true' }
 input.addEventListener('input', sync)
 form.addEventListener('submit', function (event) {
   event.preventDefault()
   if (!input.value.trim() || action.getAttribute('aria-busy') === 'true') return
   action.setAttribute('aria-busy', 'true'); sync(); error.textContent = ''
   fetch('/private/sign-in', {
     method: 'POST', headers: { 'content-type': 'application/json' },
     body: JSON.stringify(Object.assign({ handle: input.value.trim() }, payload))
   }).then(function (r) { return r.json() }).then(function (result) {
     if (result.url) location.href = result.url
     else error.textContent = 'could not start sign-in for that handle.'
   }).catch(function () { error.textContent = 'could not start sign-in.' }).finally(function () {
     action.removeAttribute('aria-busy'); sync()
   })
 })
</script>`,
	)
}

const deniedPage = (): string =>
	page(
		'not available',
		`<div class="private-brand"><strong>wisp.place</strong></div>
<p class="private-kicker">link unavailable</p>
<h1>this link is not available</h1>
<p>it may have been revoked, expired, or issued to a different account.</p>
<p class="private-note">no change was made to your account.</p>`,
	)

const htmlResponse = (set: { headers: Record<string, string | number>; status?: number | string }, body: string) => {
	set.headers['Content-Type'] = 'text/html; charset=utf-8'
	set.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, private'
	set.headers['Referrer-Policy'] = 'no-referrer'
	set.headers['X-Robots-Tag'] = 'noindex, nofollow'
	return body
}

const readBody = (body: unknown) => {
	const value = body as { siteId?: unknown; token?: unknown; handle?: unknown } | null
	return {
		siteId: typeof value?.siteId === 'string' ? value.siteId : '',
		token: typeof value?.token === 'string' ? value.token : undefined,
		handle: typeof value?.handle === 'string' ? value.handle.trim() : '',
	}
}

export const resolvePrivateShareState = async (
	state: string | null | undefined,
	viewerDid: string,
): Promise<{ url: string | null } | null> => {
	if (!state) return null
	let parsed: { kind?: unknown; siteId?: unknown; token?: unknown }
	try {
		parsed = JSON.parse(state)
	} catch {
		return null
	}
	if (typeof parsed.siteId !== 'string') return null
	if (parsed.kind === 'privateOpen') return { url: await openPrivateSiteForAccount(parsed.siteId, viewerDid) }
	if (parsed.kind !== 'privateShare' || typeof parsed.token !== 'string') return null
	return { url: await redeemScopedShare(parsed.siteId, parsed.token, viewerDid) }
}

export const privateRedeemRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({ cookie: { secrets: cookieSecret, sign: [SESSION_COOKIE_NAME] } })
		.post('/private/redeem', async ({ body, cookie, request, set }) => {
			const { siteId, token } = readBody(body)
			if (!siteId || !token) {
				set.status = 400
				return htmlResponse(set, deniedPage())
			}
			const auth = await authenticateRequest(client, cookie, request.headers.get('cookie'))
			if (!auth) return htmlResponse(set, signInPage(siteId, token))
			const url = await redeemScopedShare(siteId, token, auth.did)
			if (!url) {
				set.status = 404
				return htmlResponse(set, deniedPage())
			}
			set.status = 303
			set.headers.Location = url
			return ''
		})
		.get('/private/denied', ({ set }) => {
			set.status = 403
			return htmlResponse(set, deniedPage())
		})
		.get('/private/open', async ({ query, cookie, request, set }) => {
			const siteId = typeof query.siteId === 'string' ? query.siteId : ''
			if (!siteId) {
				set.status = 400
				return htmlResponse(set, deniedPage())
			}
			const auth = await authenticateRequest(client, cookie, request.headers.get('cookie'))
			if (!auth) return htmlResponse(set, signInPage(siteId))
			const url = await openPrivateSiteForAccount(siteId, auth.did)
			if (!url) {
				set.status = 404
				return htmlResponse(set, deniedPage())
			}
			set.status = 303
			set.headers.Location = url
			return ''
		})
		.get('/p/:token', async ({ params, set }) => {
			const target = await resolveShareLink(params.token ?? '')
			if (!target) {
				set.status = 404
				return htmlResponse(set, deniedPage())
			}
			set.status = 302
			set.headers.Location = target
			set.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, private'
			set.headers['Referrer-Policy'] = 'no-referrer'
			return ''
		})
		.post('/private/sign-in', async ({ body, set }) => {
			const { siteId, token, handle } = readBody(body)
			if (!siteId || !handle) {
				set.status = 400
				return { error: 'missing handle' }
			}
			try {
				const state = JSON.stringify({ kind: token ? 'privateShare' : 'privateOpen', siteId, token })
				return { url: (await client.authorize(handle, { state })).toString() }
			} catch (err) {
				logger.error('[PrivateSite] Sign-in failed', err)
				set.status = 400
				return { error: 'sign-in unavailable' }
			}
		})
