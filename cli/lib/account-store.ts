import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { cwd } from 'node:process'
import { getHandleForDid, resolveDid } from '@wispplace/atproto-utils'
import { isBun } from '@wispplace/bun-firehose'

export const KEYCHAIN_SERVICE = 'wispctl'
export const DEFAULT_DB_PATH = join(homedir(), '.config', 'wispctl', 'state.sqlite')

/**
 * OAuth sessions are stored under the bare DID (the `sub` the atproto session
 * store hands us), so existing keychain entries keep working untouched. App
 * passwords are long-lived credentials and live under their own prefix.
 */
const APP_PASSWORD_ACCOUNT_PREFIX = 'app-password:'

/** Read-only sentinel used to check the credential store is reachable. */
const PROBE_ACCOUNT = '__wispctl_probe__'

const ACCOUNT_PREFIX = 'account:'
const HANDLE_PREFIX = 'handle:'
const DIR_PREFIX = 'dir:'
const DEFAULT_ACCOUNT_KEY = 'default_account'
const STORE_VERSION_KEY = 'store_version'
const STORE_VERSION = '1'

/** How long a cached handle -> DID alias is trusted before re-resolving. */
const HANDLE_ALIAS_TTL_MS = 24 * 60 * 60 * 1000

export type AuthMethod = 'oauth' | 'app-password'

export interface StoredAccount {
	did: string
	handle?: string
	method: AuthMethod
	pdsUrl?: string
	addedAt: number
	lastUsedAt: number
	/** When `handle` was last confirmed against the network. */
	handleCheckedAt?: number
	/**
	 * Which OAuth scope strategy minted this session.
	 *
	 * A loopback client declares its scopes inside the `client_id`, so the two
	 * strategies are two different client identities. Restoring a session has to
	 * rebuild the same one or the token refresh is rejected.
	 */
	oauthScope?: OAuthScopeStrategy
}

/** `sets` requests `include:place.wisp.*`; `granular` requests their expansion. */
export type OAuthScopeStrategy = 'sets' | 'granular'

// ---------------------------------------------------------------------------
// Keychain access
// ---------------------------------------------------------------------------

interface KeyringEntryLike {
	setPassword(password: string): void
	getPassword(): string | null
	deletePassword(): void
}

export type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntryLike

export interface KeychainProbeResult {
	available: boolean
	detail?: string
	moduleAvailable: boolean
}

let keyringEntryConstructor: KeyringEntryConstructor | null | undefined

export async function getKeyringEntryConstructor(): Promise<KeyringEntryConstructor | null> {
	if (keyringEntryConstructor !== undefined) {
		return keyringEntryConstructor
	}
	try {
		const module = await import('@napi-rs/keyring')
		keyringEntryConstructor = module.Entry as KeyringEntryConstructor
	} catch {
		keyringEntryConstructor = null
	}
	return keyringEntryConstructor
}

function formatProbeError(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.message
	}
	if (typeof error === 'string') {
		return error
	}
	return undefined
}

export function describeUnavailableKeychain(result: KeychainProbeResult): string {
	if (process.platform === 'darwin') {
		if (!result.moduleAvailable) {
			return 'macOS Keychain support is unavailable in this build.'
		}
		if (result.detail?.toLowerCase().includes('authorization')) {
			return 'macOS Keychain access could not be authorized.'
		}
		return result.detail ? `macOS Keychain access failed: ${result.detail}` : 'macOS Keychain access is unavailable.'
	}

	if (process.platform === 'linux') {
		if (!result.moduleAvailable) {
			return 'System keychain support is unavailable in this build.'
		}
		if (result.detail?.toLowerCase().includes('secret service')) {
			return 'System keychain is unavailable (no Secret Service daemon or equivalent).'
		}
		return result.detail ? `System keychain access failed: ${result.detail}` : 'System keychain is unavailable.'
	}

	if (process.platform === 'win32') {
		if (!result.moduleAvailable) {
			return 'Windows Credential Manager support is unavailable in this build.'
		}
		return result.detail
			? `Windows Credential Manager access failed: ${result.detail}`
			: 'Windows Credential Manager is unavailable.'
	}

	if (!result.moduleAvailable) {
		return 'Secure OS credential storage is unavailable in this build.'
	}
	return result.detail
		? `Secure OS credential storage failed: ${result.detail}`
		: 'Secure OS credential storage is unavailable.'
}

/**
 * Every keychain touch is a separate OS credential-store access, and on macOS an
 * unauthorized binary is prompted for each one. A single command used to cost
 * five: a write plus a delete to probe, then reads for the session and the app
 * password. So keep one `Entry` per account for the life of the process, cache
 * what we read, and never write just to see whether the store works.
 */
const entryCache = new Map<string, KeyringEntryLike>()
const secretCache = new Map<string, string | null>()

async function getEntry(account: string): Promise<KeyringEntryLike | null> {
	const KeyringEntry = await getKeyringEntryConstructor()
	if (!KeyringEntry) return null

	const cached = entryCache.get(account)
	if (cached) return cached

	const entry = new KeyringEntry(KEYCHAIN_SERVICE, account)
	entryCache.set(account, entry)
	return entry
}

async function readSecret(account: string): Promise<string | null> {
	const cached = secretCache.get(account)
	if (cached !== undefined) return cached

	const entry = await getEntry(account)
	if (!entry) return null

	let value: string | null = null
	try {
		value = entry.getPassword()
	} catch {
		value = null
	}
	secretCache.set(account, value)
	return value
}

async function writeSecret(account: string, value: string): Promise<boolean> {
	const entry = await getEntry(account)
	if (!entry) return false
	try {
		entry.setPassword(value)
		secretCache.set(account, value)
		return true
	} catch {
		return false
	}
}

async function removeSecret(account: string): Promise<void> {
	const entry = await getEntry(account)
	if (!entry) return
	try {
		entry.deletePassword()
	} catch {}
	secretCache.set(account, null)
}

let keychainProbe: KeychainProbeResult | undefined

export async function probeKeychain(): Promise<KeychainProbeResult> {
	if (keychainProbe) return keychainProbe

	const KeyringEntry = await getKeyringEntryConstructor()
	if (!KeyringEntry) {
		keychainProbe = { available: false, moduleAvailable: false }
		return keychainProbe
	}

	try {
		// Reading a key that was never stored returns null rather than throwing,
		// which is enough to prove the store is reachable. A missing backend (no
		// Secret Service, say) throws instead. Unlike the write-then-delete probe
		// this replaces, it does not ask the user to authorize anything.
		await getEntry(PROBE_ACCOUNT).then((entry) => entry?.getPassword())
		keychainProbe = { available: true, moduleAvailable: true }
	} catch (error) {
		keychainProbe = {
			available: false,
			detail: formatProbeError(error),
			moduleAvailable: true,
		}
	}
	return keychainProbe
}

export async function getStoredAppPassword(did: string): Promise<string | null> {
	return await readSecret(`${APP_PASSWORD_ACCOUNT_PREFIX}${did}`)
}

/**
 * Persist an app password. Returns false when there is no OS credential store —
 * app passwords are long-lived and full-scope, so unlike refreshable OAuth
 * tokens they are never written to the plaintext SQLite fallback.
 */
export async function setStoredAppPassword(did: string, password: string): Promise<boolean> {
	return await writeSecret(`${APP_PASSWORD_ACCOUNT_PREFIX}${did}`, password)
}

export async function deleteStoredAppPassword(did: string): Promise<void> {
	await removeSecret(`${APP_PASSWORD_ACCOUNT_PREFIX}${did}`)
}

export async function getStoredOAuthSession(did: string): Promise<string | null> {
	return await readSecret(did)
}

export async function setStoredOAuthSession(did: string, session: string): Promise<boolean> {
	return await writeSecret(did, session)
}

export async function deleteStoredOAuthSession(did: string): Promise<void> {
	await removeSecret(did)
}

// ---------------------------------------------------------------------------
// Runtime-agnostic KV adapter — all SQL is baked in so return types are known
// ---------------------------------------------------------------------------

interface KvRow {
	value: string
	expires_at: number | null
}

interface KvEntryRow extends KvRow {
	key: string
}

export interface KvAdapter {
	get(key: string): KvRow | undefined
	set(key: string, value: string, expiresAt: number | null): void
	del(key: string): void
	clear(): void
	entriesByPrefix(prefix: string): { key: string; value: string }[]
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS kv (
		key        TEXT PRIMARY KEY,
		value      TEXT NOT NULL,
		expires_at INTEGER
	)
`

const PREFIX_QUERY = "SELECT key, value, expires_at FROM kv WHERE key LIKE ? ESCAPE '\\'"

/** Escape LIKE wildcards so a prefix is matched literally. */
function likePrefix(prefix: string): string {
	return `${prefix.replace(/[\\%_]/g, '\\$&')}%`
}

function liveEntries(rows: KvEntryRow[]): { key: string; value: string }[] {
	const now = Date.now()
	return rows
		.filter((row) => row.expires_at === null || row.expires_at > now)
		.map((row) => ({ key: row.key, value: row.value }))
}

function prepareDatabaseFile(dbPath: string): void {
	if (dbPath === ':memory:') return

	mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
	const fd = openSync(dbPath, 'a', 0o600)
	closeSync(fd)
	chmodSync(dbPath, 0o600)
}

export async function openKv(dbPath: string): Promise<KvAdapter> {
	prepareDatabaseFile(dbPath)

	if (isBun) {
		const { Database } = await import('bun:sqlite')
		const db = new Database(dbPath)
		db.run('PRAGMA journal_mode = WAL')
		db.run(SCHEMA)
		const getStmt = db.query<KvRow, [string]>('SELECT value, expires_at FROM kv WHERE key = ?')
		const setStmt = db.query('INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)')
		const delStmt = db.query('DELETE FROM kv WHERE key = ?')
		const prefixStmt = db.query<KvEntryRow, [string]>(PREFIX_QUERY)
		return {
			get: (key) => getStmt.get(key) ?? undefined,
			set: (key, value, expiresAt) => {
				setStmt.run(key, value, expiresAt)
			},
			del: (key) => {
				delStmt.run(key)
			},
			clear: () => db.run('DELETE FROM kv'),
			entriesByPrefix: (prefix) => liveEntries(prefixStmt.all(likePrefix(prefix))),
		}
	} else {
		const { DatabaseSync } = await import('node:sqlite')
		const db = new DatabaseSync(dbPath)
		db.exec('PRAGMA journal_mode = WAL')
		db.exec(SCHEMA)
		const getStmt = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?')
		const setStmt = db.prepare('INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)')
		const delStmt = db.prepare('DELETE FROM kv WHERE key = ?')
		const prefixStmt = db.prepare(PREFIX_QUERY)
		return {
			get: (key) => getStmt.get(key) as KvRow | undefined,
			set: (key, value, expiresAt) => {
				setStmt.run(key, value, expiresAt)
			},
			del: (key) => {
				delStmt.run(key)
			},
			clear: () => db.exec('DELETE FROM kv'),
			entriesByPrefix: (prefix) => liveEntries(prefixStmt.all(likePrefix(prefix)) as unknown as KvEntryRow[]),
		}
	}
}

export function kvGet(kv: KvAdapter, key: string): string | undefined {
	const row = kv.get(key)
	if (!row) return undefined
	if (row.expires_at !== null && row.expires_at <= Date.now()) {
		kv.del(key)
		return undefined
	}
	return row.value
}

export function kvSet(kv: KvAdapter, key: string, value: string, ttlSeconds?: number): void {
	const expiresAt = ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : null
	kv.set(key, value, expiresAt)
}

// ---------------------------------------------------------------------------
// Account records
// ---------------------------------------------------------------------------

export function normalizeHandle(handle: string): string {
	return handle.trim().toLowerCase().replace(/^@/, '')
}

function parseStoredAccount(raw: string): StoredAccount | undefined {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		return undefined
	}
	if (!value || typeof value !== 'object') return undefined

	const account = value as Partial<StoredAccount>
	if (
		typeof account.did !== 'string' ||
		!account.did.startsWith('did:') ||
		(account.handle !== undefined && typeof account.handle !== 'string') ||
		(account.pdsUrl !== undefined && typeof account.pdsUrl !== 'string') ||
		(account.method !== 'oauth' && account.method !== 'app-password') ||
		typeof account.addedAt !== 'number' ||
		!Number.isFinite(account.addedAt) ||
		typeof account.lastUsedAt !== 'number' ||
		!Number.isFinite(account.lastUsedAt) ||
		(account.handleCheckedAt !== undefined &&
			(typeof account.handleCheckedAt !== 'number' || !Number.isFinite(account.handleCheckedAt)))
	) {
		return undefined
	}

	return account as StoredAccount
}

export function readAccount(kv: KvAdapter, did: string): StoredAccount | undefined {
	const raw = kvGet(kv, `${ACCOUNT_PREFIX}${did}`)
	return raw ? parseStoredAccount(raw) : undefined
}

export function writeAccount(kv: KvAdapter, account: StoredAccount): void {
	kvSet(kv, `${ACCOUNT_PREFIX}${account.did}`, JSON.stringify(account))
	if (account.handle) {
		kvSet(kv, `${HANDLE_PREFIX}${account.handle}`, account.did)
	}
}

export function listAccounts(kv: KvAdapter): StoredAccount[] {
	return kv
		.entriesByPrefix(ACCOUNT_PREFIX)
		.map(({ value }) => parseStoredAccount(value))
		.filter((account): account is StoredAccount => account !== undefined)
		.sort((a, b) => (a.handle ?? a.did).localeCompare(b.handle ?? b.did))
}
function detachHandle(kv: KvAdapter, did: string, handle: string): void {
	const aliasKey = `${HANDLE_PREFIX}${handle}`
	if (kvGet(kv, aliasKey) === did) {
		kv.del(aliasKey)
	}

	const account = readAccount(kv, did)
	if (account?.handle !== handle) return

	const updated = { ...account }
	delete updated.handle
	delete updated.handleCheckedAt
	kvSet(kv, `${ACCOUNT_PREFIX}${did}`, JSON.stringify(updated))
}

/**
 * Create or refresh the account record for `did`. Non-secret bookkeeping only —
 * credentials themselves live in the keychain.
 */
export function upsertAccount(
	kv: KvAdapter,
	did: string,
	updates: {
		handle?: string
		method?: AuthMethod
		pdsUrl?: string
		handleChecked?: boolean
		oauthScope?: OAuthScopeStrategy
	} = {},
): StoredAccount {
	const now = Date.now()
	const existing = readAccount(kv, did)
	const handle = updates.handle ? normalizeHandle(updates.handle) : existing?.handle

	if (existing?.handle && existing.handle !== handle) {
		detachHandle(kv, did, existing.handle)
	}
	if (handle) {
		const ownerDid = kvGet(kv, `${HANDLE_PREFIX}${handle}`)
		if (ownerDid && ownerDid !== did) {
			detachHandle(kv, ownerDid, handle)
		}
	}

	const account: StoredAccount = {
		did,
		handle,
		method: updates.method ?? existing?.method ?? 'oauth',
		pdsUrl: updates.pdsUrl ?? existing?.pdsUrl,
		addedAt: existing?.addedAt ?? now,
		lastUsedAt: now,
		handleCheckedAt: updates.handleChecked ? now : handle !== existing?.handle ? undefined : existing?.handleCheckedAt,
		oauthScope: updates.oauthScope ?? existing?.oauthScope,
	}
	writeAccount(kv, account)
	return account
}

export function deleteAccount(kv: KvAdapter, did: string): void {
	const account = readAccount(kv, did)
	if (account?.handle) {
		kv.del(`${HANDLE_PREFIX}${account.handle}`)
	}
	// Any other alias rows still pointing at this DID.
	for (const { key, value } of kv.entriesByPrefix(HANDLE_PREFIX)) {
		if (value === did) kv.del(key)
	}
	for (const { key, value } of kv.entriesByPrefix(DIR_PREFIX)) {
		if (value === did) kv.del(key)
	}
	if (kvGet(kv, DEFAULT_ACCOUNT_KEY) === did) {
		kv.del(DEFAULT_ACCOUNT_KEY)
	}
	kv.del(`${ACCOUNT_PREFIX}${did}`)
}

// ---------------------------------------------------------------------------
// Directory + default account mappings
// ---------------------------------------------------------------------------

export function dirKey(dir: string = cwd()): string {
	return `${DIR_PREFIX}${dir}`
}

export function getDirDid(kv: KvAdapter): string | undefined {
	return kvGet(kv, dirKey())
}

export function setDirDid(kv: KvAdapter, did: string): void {
	kvSet(kv, dirKey(), did)
}

export function clearDirDid(kv: KvAdapter): void {
	kv.del(dirKey())
}

export function getDefaultDid(kv: KvAdapter): string | undefined {
	return kvGet(kv, DEFAULT_ACCOUNT_KEY)
}

export function setDefaultDid(kv: KvAdapter, did: string): void {
	kvSet(kv, DEFAULT_ACCOUNT_KEY, did)
}

export function listDirsForDid(kv: KvAdapter, did: string): string[] {
	return kv
		.entriesByPrefix(DIR_PREFIX)
		.filter(({ value }) => value === did)
		.map(({ key }) => key.slice(DIR_PREFIX.length))
}

/**
 * Which account a bare command in this directory should use.
 *
 * Directory mapping wins, then an explicitly chosen default (`wispctl accounts
 * use`), then a lone stored account. With several accounts and no explicit
 * choice we return nothing so the caller prompts rather than guessing an
 * identity to deploy as.
 */
export function resolveAccountForDir(kv: KvAdapter): StoredAccount | undefined {
	const dirDid = getDirDid(kv)
	if (dirDid) {
		return readAccount(kv, dirDid) ?? upsertAccount(kv, dirDid)
	}

	const defaultDid = getDefaultDid(kv)
	if (defaultDid) {
		const account = readAccount(kv, defaultDid)
		if (account) return account
	}

	const accounts = listAccounts(kv)
	return accounts.length === 1 ? accounts[0] : undefined
}

// ---------------------------------------------------------------------------
// Identifier resolution
// ---------------------------------------------------------------------------

function isAliasFresh(account: StoredAccount | undefined, handle: string): boolean {
	if (!account || account.handle !== handle) return false
	return account.handleCheckedAt !== undefined && Date.now() - account.handleCheckedAt < HANDLE_ALIAS_TTL_MS
}

/**
 * Resolve a handle or DID to a DID, preferring the local alias cache so the
 * common case costs no network round trip. A stale or missing alias falls
 * through to a real resolve; a failed resolve falls back to the cache so the
 * CLI still works offline against an already-known account.
 */
export async function resolveIdentifierToDid(kv: KvAdapter, identifier: string): Promise<string | null> {
	if (identifier.startsWith('did:')) {
		return identifier
	}

	const handle = normalizeHandle(identifier)
	const cachedDid = kvGet(kv, `${HANDLE_PREFIX}${handle}`)
	if (cachedDid && isAliasFresh(readAccount(kv, cachedDid), handle)) {
		return cachedDid
	}

	const resolved = await resolveDid(handle).catch(() => null)
	if (!resolved) {
		return cachedDid ?? null
	}

	if (cachedDid && cachedDid !== resolved) {
		detachHandle(kv, cachedDid, handle)
	}
	if (readAccount(kv, resolved)) {
		upsertAccount(kv, resolved, { handle, handleChecked: true })
	} else {
		kvSet(kv, `${HANDLE_PREFIX}${handle}`, resolved)
	}
	return resolved
}

/** Fill in a missing handle for an account we only know by DID. */
export async function backfillHandle(kv: KvAdapter, did: string): Promise<string | undefined> {
	const account = readAccount(kv, did)
	if (account?.handle) return account.handle
	const handle = await getHandleForDid(did).catch(() => null)
	if (!handle) return undefined
	return upsertAccount(kv, did, { handle: handle, handleChecked: true }).handle
}

// ---------------------------------------------------------------------------
// Store bootstrap
// ---------------------------------------------------------------------------

/**
 * Promote pre-existing per-directory mappings into account records. Handles are
 * filled in lazily on first use, so this stays offline and cheap.
 */
function migrateDirMappings(kv: KvAdapter): void {
	if (kvGet(kv, STORE_VERSION_KEY) === STORE_VERSION) return
	for (const { value: did } of kv.entriesByPrefix(DIR_PREFIX)) {
		if (!did.startsWith('did:')) continue
		if (!readAccount(kv, did)) {
			upsertAccount(kv, did, { method: 'oauth' })
		}
	}
	kvSet(kv, STORE_VERSION_KEY, STORE_VERSION)
}

export async function openAccountStore(dbPath?: string): Promise<KvAdapter> {
	const kv = await openKv(dbPath || DEFAULT_DB_PATH)
	migrateDirMappings(kv)
	return kv
}
