import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAccounts, openKv, readAccount, resolveIdentifierToDid, upsertAccount } from './account-store.ts'
import { logoutAccount } from './auth.ts'

const temporaryDirectories: string[] = []

function createDatabasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), 'wispctl-account-store-'))
	temporaryDirectories.push(directory)
	return join(directory, 'state.sqlite')
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

describe('account store', () => {
	test('creates the state database with owner-only permissions', async () => {
		if (process.platform === 'win32') return

		const dbPath = createDatabasePath()
		await openKv(dbPath)

		expect(statSync(dbPath).mode & 0o777).toBe(0o600)
	})

	test('keeps a handle alias attached to only one account', async () => {
		const kv = await openKv(createDatabasePath())
		upsertAccount(kv, 'did:plc:old', { handle: 'alice.example', handleChecked: true })
		upsertAccount(kv, 'did:plc:new', { handle: 'alice.example', handleChecked: true })

		expect(readAccount(kv, 'did:plc:old')?.handle).toBeUndefined()
		expect(readAccount(kv, 'did:plc:new')?.handle).toBe('alice.example')
		expect(await resolveIdentifierToDid(kv, '@ALICE.EXAMPLE')).toBe('did:plc:new')
	})

	test('ignores malformed account rows', async () => {
		const kv = await openKv(createDatabasePath())
		kv.set('account:did:plc:broken', '{"did":"did:plc:broken","method":"unknown"}', null)

		expect(readAccount(kv, 'did:plc:broken')).toBeUndefined()
		expect(listAccounts(kv)).toEqual([])
	})

	test('does not report an unknown did as removed', async () => {
		const dbPath = createDatabasePath()

		expect(await logoutAccount('did:plc:missing', dbPath)).toBeUndefined()
	})
})
