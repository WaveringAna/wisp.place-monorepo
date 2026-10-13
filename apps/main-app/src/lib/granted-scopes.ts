import { createTtlMemoryStore } from './ttl-memory-store'

/**
 * The scope granted by the most recently stored session, per subject.
 *
 * The OAuth callback has to know what the authorization server actually granted
 * so it can detect a server that accepted the `include:place.wisp.*` permission
 * sets and then dropped them. Asking the session for it costs a full advisory
 * lock cycle and a read on the primary, microseconds after this process wrote
 * the very value being read. Only the scope string is remembered — never a
 * token — so nothing here can serve a stale credential to a refresh.
 */
const grantedScopes = createTtlMemoryStore<string, string>({ ttlMs: 60_000, max: 500 })

/** The granted scope recorded when this process last stored a session. */
export const recentGrantedScope = (sub: string): string | undefined => grantedScopes.get(sub)

/** Record the scope of a session this process just stored. */
export const rememberGrantedScope = (sub: string, scope: string): void => {
	grantedScopes.set(sub, scope)
}

/** Forget the scope of a session this process just deleted. */
export const forgetGrantedScope = (sub: string): void => {
	grantedScopes.del(sub)
}
