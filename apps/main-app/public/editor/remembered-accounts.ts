import type { UserInfo } from './api'

/**
 * Accounts that signed in on this device, newest first, for the landing
 * page's account picker. Shared with landingpage.html by key and shape.
 */
const KEY = 'wisp-accounts'
const LIMIT = 5

interface RememberedAccount {
	did: string
	handle: string
}

const read = (): RememberedAccount[] => {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

/** Remember the signed-in account; storage failures only cost the shortcut. */
export const rememberAccount = (user: UserInfo): UserInfo => {
	if (user.handle === 'unknown') return user
	const accounts = [{ did: user.did, handle: user.handle }, ...read().filter((a) => a.did !== user.did)]
	try {
		localStorage.setItem(KEY, JSON.stringify(accounts.slice(0, LIMIT)))
	} catch {}
	return user
}
