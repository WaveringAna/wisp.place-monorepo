import { timingSafeEqual } from 'node:crypto'
import type { Cookie } from 'elysia'

/**
 * Binds an OAuth sign-in to the browser that started it.
 *
 * The callback URL carries everything the OAuth client needs, so without a
 * binding anyone could pause their own sign-in and get another browser to
 * open its callback, signing that browser into their account. Starting a
 * sign-in sets this cookie to a fresh flow id and puts the same id in
 * `state`; the callback accepts only a state whose id matches the cookie.
 * __Host- keeps user-content subdomains from tossing their own value in.
 */
export const OAUTH_FLOW_COOKIE_NAME =
	process.env.NODE_ENV === 'production' ? '__Host-wisp-oauth-flow' : 'wisp-oauth-flow'

const FLOW_KEY = 'wispFlow'
const FLOW_MAX_AGE_SECONDS = 15 * 60

type Cookies = Record<string, Cookie<unknown>>

const parseObject = (state: string | null | undefined): Record<string, unknown> => {
	if (!state) return {}
	try {
		const parsed = JSON.parse(state)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
	} catch {
		return {}
	}
}

/** `state` with a new flow id, which this browser's cookie now holds too. */
export const startOAuthFlow = (cookie: Cookies, state?: string): string => {
	const flow = crypto.randomUUID()
	cookie[OAUTH_FLOW_COOKIE_NAME].set({
		value: flow,
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		path: '/',
		maxAge: FLOW_MAX_AGE_SECONDS,
	})
	return JSON.stringify({ ...parseObject(state), [FLOW_KEY]: flow })
}

/** Whether `state` came back to the browser that started its sign-in. */
export const isOwnOAuthFlow = (cookie: Cookies, state: string | null | undefined): boolean => {
	const flow = parseObject(state)[FLOW_KEY]
	const held = cookie[OAUTH_FLOW_COOKIE_NAME]?.value
	if (typeof flow !== 'string' || typeof held !== 'string') return false
	const a = Buffer.from(flow)
	const b = Buffer.from(held)
	return a.length === b.length && timingSafeEqual(a, b)
}

export const endOAuthFlow = (cookie: Cookies): void => {
	cookie[OAUTH_FLOW_COOKIE_NAME].remove()
}
