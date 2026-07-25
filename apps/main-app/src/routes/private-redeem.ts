/**
 * Identity bounce for DID-scoped private share links.
 *
 * A private site is served from its own origin, which deliberately cannot read the account
 * cookie — that isolation is what stops one tenant's JavaScript from reading another's.
 * A share scoped to a DID therefore has no way to learn who the viewer is, so the private
 * origin posts the visitor here, where the account cookie *is* readable.
 *
 * This is a top-level form POST rather than a credentialed `fetch` on purpose: allowing
 * CORS from `*.priv.<host>` would let untrusted user-uploaded JavaScript reach this API
 * with the owner's cookie attached. A navigation needs no CORS.
 *
 * Every failure renders the same generic page, so this endpoint cannot be used to discover
 * whether a private site exists.
 */

import type { NodeOAuthClient } from '@atproto/oauth-client-node'
import { createLogger } from '@wispplace/observability'
import { Elysia } from 'elysia'
import { openOwnedPrivateSite, redeemScopedShare, resolveShareLink } from '../lib/private-sites-service'
import { authenticateRequest } from '../lib/wisp-auth'

const logger = createLogger('main-app')

/** Embed a value in an inline script without letting it break out of the string. */
const json = (value: string): string =>
	JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')


/**
 * Re-present the share token after sign-in.
 *
 * The visitor arrives without a session, so they are sent through OAuth and land back here
 * with the token still in a POST body rather than in a URL.
 */
const signInPage = (siteId: string, token: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>sign in — wisp.place</title>
<style>
 body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#12111a;color:#e8e6f0;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
 main{max-width:32rem;border:1px solid #322e44;border-radius:10px;padding:2rem;line-height:1.6}
 h1{margin:0 0 .75rem;font-size:1.15rem;color:#c4a7ff}
 p{margin:.5rem 0;color:#b9b3c9}
 label{display:block;margin-top:1rem;color:#b9b3c9}
 input[type=text]{width:100%;box-sizing:border-box;margin-top:.35rem;padding:.6rem;border-radius:6px;
   border:1px solid #322e44;background:#1b1926;color:#e8e6f0;font:inherit}
 button{margin-top:1rem;background:#7c5cff;color:#fff;border:0;border-radius:6px;
        padding:.7rem 1.2rem;font:inherit;cursor:pointer}
</style></head>
<body><main>
<h1>sign in to open this link</h1>
<p>this private site was shared with a specific account.</p>
<form id="f">
 <label>your handle
  <input type="text" id="handle" placeholder="alice.bsky.social" autocapitalize="none" autocorrect="off" required>
 </label>
 <button type="submit">continue</button>
 <p class="err" id="err"></p>
</form>
<script>
 var siteId = ${json(siteId)}, token = ${json(token)}
 document.getElementById('f').addEventListener('submit', function (e) {
   e.preventDefault()
   var handle = document.getElementById('handle').value.trim()
   if (!handle) return
   fetch('/private/redeem/start', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ siteId: siteId, token: token, handle: handle })
   }).then(function (r) { return r.json() }).then(function (d) {
     if (d && d.url) { location.href = d.url } else { document.getElementById('err').textContent = 'could not start sign-in for that handle.' }
   }).catch(function () { document.getElementById('err').textContent = 'could not start sign-in.' })
 })
</script>
</main></body></html>`

/** Sign-in prompt for an owner opening their own private site by address. */
const ownerSignInPage = (siteId: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>sign in — wisp.place</title>
<style>
 body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#12111a;color:#e8e6f0;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
 main{max-width:32rem;border:1px solid #322e44;border-radius:10px;padding:2rem;line-height:1.6}
 h1{margin:0 0 .75rem;font-size:1.15rem;color:#c4a7ff}
 p{margin:.5rem 0;color:#b9b3c9}
 label{display:block;margin-top:1rem;color:#b9b3c9}
 input[type=text]{width:100%;box-sizing:border-box;margin-top:.35rem;padding:.6rem;border-radius:6px;
   border:1px solid #322e44;background:#1b1926;color:#e8e6f0;font:inherit}
 button{margin-top:1rem;background:#7c5cff;color:#fff;border:0;border-radius:6px;
        padding:.7rem 1.2rem;font:inherit;cursor:pointer}
</style></head>
<body><main>
<h1>sign in to open this private site</h1>
<p>only the account that created it can open it without a share link.</p>
<form id="f">
 <label>your handle
  <input type="text" id="handle" placeholder="alice.bsky.social" autocapitalize="none" autocorrect="off" required>
 </label>
 <button type="submit">continue</button>
 <p class="err" id="err"></p>
</form>
<script>
 var siteId = ${json(siteId)}
 document.getElementById('f').addEventListener('submit', function (e) {
   e.preventDefault()
   var handle = document.getElementById('handle').value.trim()
   if (!handle) return
   fetch('/private/open/start', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ siteId: siteId, handle: handle })
   }).then(function (r) { return r.json() }).then(function (d) {
     if (d && d.url) { location.href = d.url } else { document.getElementById('err').textContent = 'could not start sign-in for that handle.' }
   }).catch(function () { document.getElementById('err').textContent = 'could not start sign-in.' })
 })
</script>
</main></body></html>`

/** Shown for every failure, so no outcome reveals whether a private site exists. */
const deniedPage = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>not available — wisp.place</title>
<style>
 body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#12111a;color:#e8e6f0;
      display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
 main{max-width:30rem;border:1px solid #322e44;border-radius:10px;padding:2rem;line-height:1.6}
 h1{margin:0 0 .75rem;font-size:1.15rem;color:#c4a7ff}
 p{margin:.5rem 0;color:#b9b3c9}
</style></head>
<body><main>
<h1>this link is not available</h1>
<p>it may have been revoked, expired, or issued to a different account.</p>
</main></body></html>`

const htmlResponse = (
	set: { headers: Record<string, string | number>; status?: number | string },
	body: string,
): string => {
	set.headers['Content-Type'] = 'text/html; charset=utf-8'
	// Carries a share token in the markup, so it must never be cached or indexed.
	set.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, private'
	set.headers['Referrer-Policy'] = 'no-referrer'
	set.headers['X-Robots-Tag'] = 'noindex, nofollow'
	return body
}

const readForm = (body: unknown): { siteId: string; token: string } | null => {
	const form = body as { siteId?: unknown; token?: unknown } | null
	const siteId = typeof form?.siteId === 'string' ? form.siteId : ''
	const token = typeof form?.token === 'string' ? form.token : ''
	if (!siteId || !token) return null
	return { siteId, token }
}

/**
 * Finish a share redemption that went through OAuth.
 *
 * Returns the private-origin URL to land on, or null when the state is not a private-share
 * round trip or the share no longer grants access. The token in the state is re-validated
 * by `redeemScopedShare`, so a forged state yields nothing.
 */
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

	if (parsed.kind === 'privateOpen') {
		return { url: await openOwnedPrivateSite(parsed.siteId, viewerDid) }
	}
	if (parsed.kind !== 'privateShare') return null
	if (typeof parsed.token !== 'string') return null

	return { url: await redeemScopedShare(parsed.siteId, parsed.token, viewerDid) }
}

export const privateRedeemRoutes = (client: NodeOAuthClient, cookieSecret: string) =>
	new Elysia({ cookie: { secrets: cookieSecret, sign: ['did'] } })
		/**
		 * POST /private/redeem
		 *
		 * Entry point from a private origin's sign-in interstitial. If the visitor already
		 * has an account session, the share is evaluated immediately and they are redirected
		 * back with a single-use handoff. Otherwise they are offered sign-in.
		 */
		.post('/private/redeem', async ({ body, cookie, set }) => {
			const form = readForm(body)
			if (!form) {
				set.status = 400
				return htmlResponse(set, deniedPage())
			}

			const auth = await authenticateRequest(client, cookie)
			if (!auth) {
				return htmlResponse(set, signInPage(form.siteId, form.token))
			}

			const url = await redeemScopedShare(form.siteId, form.token, auth.did)
			if (!url) {
				set.status = 404
				return htmlResponse(set, deniedPage())
			}

			set.status = 303
			set.headers.Location = url
			return ''
		})
		/** Explanation page for a sign-in that did not grant access. */
		.get('/private/denied', ({ set }) => {
			set.status = 403
			return htmlResponse(set, deniedPage())
		})
		/**
		 * GET /p/:token
		 *
		 * The human-friendly form of a share link. `wisp.place/p/<token>` is what gets
		 * pasted into a chat; it resolves the token to its site and redirects to that site's
		 * own origin carrying the same credential.
		 *
		 * The token is not stored twice: this is the *same* share token `?k=` carries, so
		 * revocation and expiry remain a single fact about a single row.
		 *
		 * A lookup failure renders the generic denial page. That reveals nothing a holder
		 * could not already learn by following the link, and someone without the token
		 * cannot ask the question at all. `redactSecretPath` keeps the token out of metrics
		 * labels and error logs.
		 */
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
		/**
		 * POST /private/open
		 *
		 * Owner entry from a private origin's sign-in page. The visitor typed a private
		 * hostname directly; the private origin cannot read the account cookie, so it posts
		 * here. If the signed-in account owns that site, they are redirected back with a
		 * single-use handoff.
		 *
		 * A non-owner and a non-existent site produce the identical denial page, so this
		 * cannot be used to enumerate private sites.
		 */
		.post('/private/open', async ({ body, cookie, set }) => {
			const siteId =
				typeof (body as { siteId?: unknown } | null)?.siteId === 'string' ? (body as { siteId: string }).siteId : ''
			if (!siteId) {
				set.status = 400
				return htmlResponse(set, deniedPage())
			}

			const auth = await authenticateRequest(client, cookie)
			if (!auth) {
				return htmlResponse(set, ownerSignInPage(siteId))
			}

			const url = await openOwnedPrivateSite(siteId, auth.did)
			if (!url) {
				set.status = 404
				return htmlResponse(set, deniedPage())
			}

			set.status = 303
			set.headers.Location = url
			return ''
		})
		/**
		 * POST /private/open/start
		 *
		 * Begins OAuth for an owner who is not signed in yet. Only the site id round-trips
		 * through the OAuth state; there is no credential to protect here.
		 */
		.post('/private/open/start', async ({ body, set }) => {
			const siteId =
				typeof (body as { siteId?: unknown } | null)?.siteId === 'string' ? (body as { siteId: string }).siteId : ''
			const handle =
				typeof (body as { handle?: unknown } | null)?.handle === 'string'
					? (body as { handle: string }).handle.trim()
					: ''
			if (!siteId || !handle) {
				set.status = 400
				return { error: 'missing handle' }
			}

			try {
				const state = JSON.stringify({ kind: 'privateOpen', siteId })
				const authUrl = await client.authorize(handle, { state })
				// Returned as JSON for the page to navigate to, rather than as a redirect:
				// CSP `form-action 'self'` is enforced across redirects, so answering a form
				// POST with a cross-origin redirect to the PDS is blocked by the browser.
				return { url: authUrl.toString() }
			} catch (err) {
				logger.error('[PrivateSite] Owner sign-in failed', err)
				set.status = 400
				return { error: 'sign-in unavailable' }
			}
		})
		/**
		 * POST /private/redeem/start
		 *
		 * Begins OAuth for a visitor who needs to sign in first. The share token is carried
		 * through the round trip in the OAuth `state`, never in a query string.
		 */
		.post('/private/redeem/start', async ({ body, set }) => {
			const form = readForm(body)
			const handle =
				typeof (body as { handle?: unknown } | null)?.handle === 'string'
					? ((body as { handle: string }).handle satisfies string).trim()
					: ''
			if (!form || !handle) {
				set.status = 400
				return { error: 'missing handle' }
			}

			try {
				const state = JSON.stringify({ kind: 'privateShare', siteId: form.siteId, token: form.token })
				const authUrl = await client.authorize(handle, { state })
				// Returned as JSON for the page to navigate to, rather than as a redirect:
				// CSP `form-action 'self'` is enforced across redirects, so answering a form
				// POST with a cross-origin redirect to the PDS is blocked by the browser.
				return { url: authUrl.toString() }
			} catch (err) {
				logger.error('[PrivateSite] Redeem sign-in failed', err)
				set.status = 400
				return { error: 'sign-in unavailable' }
			}
		})
