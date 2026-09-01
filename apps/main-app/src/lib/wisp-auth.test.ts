import { afterEach, describe, expect, test } from 'bun:test'
import type { NodeOAuthClient, OAuthSession } from '@atproto/oauth-client-node'
import type { Cookie } from 'elysia'
import {
	authenticateRequest,
	clearSessionCache,
	invalidateSessionCache,
	requireAuth,
	SESSION_COOKIE_NAME,
} from './wisp-auth'

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'

const cookies = (did?: string): Record<string, Cookie<unknown>> =>
	(did ? { [SESSION_COOKIE_NAME]: { value: did } } : {}) as unknown as Record<string, Cookie<unknown>>

interface StubClient {
	client: NodeOAuthClient
	restores: string[]
	settle: (sub: string) => void
}

/**
 * A client whose `restore` only resolves when the test releases it, so a burst
 * of callers can be observed while the first restore is still in flight.
 */
const stubClient = (options: { fail?: boolean; session?: OAuthSession | null } = {}): StubClient => {
	const restores: string[] = []
	const waiting = new Map<string, () => void>()

	const client = {
		restore: (sub: string) => {
			restores.push(sub)
			return new Promise((resolve, reject) => {
				waiting.set(sub, () => {
					if (options.fail) reject(new Error('restore failed'))
					else resolve(options.session === undefined ? ({ did: sub, sub } as unknown as OAuthSession) : options.session)
				})
			})
		},
	} as unknown as NodeOAuthClient

	return {
		client,
		restores,
		settle: (sub) => {
			waiting.get(sub)?.()
			waiting.delete(sub)
		},
	}
}

afterEach(() => {
	clearSessionCache()
})

describe('authenticateRequest', () => {
	test('returns null without a session cookie and never restores', async () => {
		const stub = stubClient()
		expect(await authenticateRequest(stub.client, cookies())).toBeNull()
		expect(stub.restores).toEqual([])
	})

	test('rejects a request carrying the session cookie twice', async () => {
		const stub = stubClient()
		const header = `${SESSION_COOKIE_NAME}=${DID}; ${SESSION_COOKIE_NAME}=other`

		expect(await authenticateRequest(stub.client, cookies(DID), header)).toBeNull()
		expect(stub.restores).toEqual([])
	})

	test('collapses a burst of concurrent requests into one restore', async () => {
		const stub = stubClient()
		const pending = Array.from({ length: 8 }, () => authenticateRequest(stub.client, cookies(DID)))

		// All eight are now waiting on the same in-flight restore.
		expect(stub.restores).toEqual([DID])

		stub.settle(DID)
		const results = await Promise.all(pending)

		expect(stub.restores).toEqual([DID])
		for (const result of results) expect(result?.did).toBe(DID)
	})

	test('answers later requests from the cache', async () => {
		const stub = stubClient()
		const first = authenticateRequest(stub.client, cookies(DID))
		stub.settle(DID)
		await first

		expect(await authenticateRequest(stub.client, cookies(DID))).not.toBeNull()
		expect(stub.restores).toEqual([DID])
	})

	test('invalidating forces the next request to restore again', async () => {
		const stub = stubClient()
		const first = authenticateRequest(stub.client, cookies(DID))
		stub.settle(DID)
		await first

		invalidateSessionCache(DID)
		const second = authenticateRequest(stub.client, cookies(DID))
		stub.settle(DID)
		await second

		expect(stub.restores).toEqual([DID, DID])
	})

	test('does not cache a failed restore', async () => {
		const stub = stubClient({ fail: true })
		const first = authenticateRequest(stub.client, cookies(DID))
		stub.settle(DID)
		expect(await first).toBeNull()

		const second = authenticateRequest(stub.client, cookies(DID))
		stub.settle(DID)
		expect(await second).toBeNull()

		// A user signing in right now must not be held out by a cached failure.
		expect(stub.restores).toEqual([DID, DID])
	})

	test('does not cache a missing session', async () => {
		const stub = stubClient({ session: null })
		const first = authenticateRequest(stub.client, cookies(DID))
		stub.settle(DID)
		expect(await first).toBeNull()

		const second = authenticateRequest(stub.client, cookies(DID))
		stub.settle(DID)
		expect(await second).toBeNull()

		expect(stub.restores).toEqual([DID, DID])
	})
})

describe('requireAuth', () => {
	test('throws when there is no session', async () => {
		const stub = stubClient()
		await expect(requireAuth(stub.client, cookies())).rejects.toThrow('Authentication required')
	})
})
