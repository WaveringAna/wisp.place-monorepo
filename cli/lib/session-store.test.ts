import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeSavedSession } from '@atproto/oauth-client-node'
import { openKv } from './account-store.ts'
import { createSessionStore, type SessionSecretStore } from './auth.ts'

const temporaryDirectories: string[] = []

async function openTempKv() {
	const directory = mkdtempSync(join(tmpdir(), 'wispctl-session-store-'))
	temporaryDirectories.push(directory)
	return await openKv(join(directory, 'state.sqlite'))
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

function fakeKeychain(acceptWrites: boolean): SessionSecretStore & { secrets: Map<string, string> } {
	const secrets = new Map<string, string>()
	return {
		secrets,
		async read(sub) {
			return secrets.get(sub) ?? null
		},
		async write(sub, value) {
			if (!acceptWrites) return false
			secrets.set(sub, value)
			return true
		},
		async remove(sub) {
			secrets.delete(sub)
		},
	}
}

const DID = 'did:plc:session-owner'
const session = { tokenSet: { sub: DID, access_token: 'a'.repeat(3000) } } as unknown as NodeSavedSession

describe('OAuth session store', () => {
	test('keeps a session the keychain refused, instead of losing it', async () => {
		const kv = await openTempKv()
		const keychain = fakeKeychain(false)
		let warnings = 0
		const store = createSessionStore(kv, keychain, () => warnings++)

		await store.set(DID, session)

		expect(await store.get(DID)).toEqual(session)
		expect(keychain.secrets.size).toBe(0)
		expect(warnings).toBe(1)
	})

	test('stores in the keychain and clears an older local copy', async () => {
		const kv = await openTempKv()
		await createSessionStore(kv, undefined).set(DID, session)
		const keychain = fakeKeychain(true)
		const store = createSessionStore(kv, keychain)

		await store.set(DID, session)

		expect(keychain.secrets.has(DID)).toBe(true)
		expect(await createSessionStore(kv, undefined).get(DID)).toBeUndefined()
		expect(await store.get(DID)).toEqual(session)
	})

	test('deletes from both stores', async () => {
		const kv = await openTempKv()
		const keychain = fakeKeychain(true)
		await createSessionStore(kv, undefined).set(DID, session)
		keychain.secrets.set(DID, JSON.stringify(session))
		const store = createSessionStore(kv, keychain)

		await store.del(DID)

		expect(await store.get(DID)).toBeUndefined()
	})

	test('works with no keychain at all', async () => {
		const kv = await openTempKv()
		const store = createSessionStore(kv, undefined)

		await store.set(DID, session)

		expect(await store.get(DID)).toEqual(session)
	})
})
