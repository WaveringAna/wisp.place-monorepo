import { NodeOAuthClient, type ClientMetadata } from "@atproto/oauth-client-node";
import { SQL } from "bun";
import { JoseKey } from "@atproto/jwk-jose";
import { BASE_HOST } from "./constants";

export const db = new SQL(
    process.env.NODE_ENV === 'production'
        ? process.env.DATABASE_URL || (() => {
            throw new Error('DATABASE_URL environment variable is required in production');
          })()
        : process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/wisp"
);

await db`
    CREATE TABLE IF NOT EXISTS oauth_states (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
`;

await db`
    CREATE TABLE IF NOT EXISTS oauth_sessions (
        sub TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
`;

await db`
    CREATE TABLE IF NOT EXISTS oauth_keys (
        kid TEXT PRIMARY KEY,
        jwk TEXT NOT NULL
    )
`;

// Domains table maps subdomain -> DID
await db`
    CREATE TABLE IF NOT EXISTS domains (
        domain TEXT PRIMARY KEY,
        did TEXT UNIQUE NOT NULL,
        rkey TEXT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
`;

// Add rkey column if it doesn't exist (for existing databases)
try {
    await db`ALTER TABLE domains ADD COLUMN IF NOT EXISTS rkey TEXT`;
} catch (err) {
    // Column might already exist, ignore
}

// Custom domains table for BYOD (bring your own domain)
await db`
    CREATE TABLE IF NOT EXISTS custom_domains (
        id TEXT PRIMARY KEY,
        domain TEXT UNIQUE NOT NULL,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL DEFAULT 'self',
        verified BOOLEAN DEFAULT false,
        last_verified_at BIGINT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
`;

// Sites table - cache of place.wisp.fs records from PDS
await db`
    CREATE TABLE IF NOT EXISTS sites (
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        display_name TEXT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
        updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
        PRIMARY KEY (did, rkey)
    )
`;

const RESERVED_HANDLES = new Set([
    "www",
    "api",
    "admin",
    "static",
    "public",
    "preview"
]);

export const isValidHandle = (handle: string): boolean => {
    const h = handle.trim().toLowerCase();
    if (h.length < 3 || h.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(h)) return false;
    if (h.startsWith('-') || h.endsWith('-')) return false;
    if (h.includes('--')) return false;
    if (RESERVED_HANDLES.has(h)) return false;
    return true;
};

export const toDomain = (handle: string): string => `${handle.toLowerCase()}.${BASE_HOST}`;

export const getDomainByDid = async (did: string): Promise<string | null> => {
    const rows = await db`SELECT domain FROM domains WHERE did = ${did}`;
    return rows[0]?.domain ?? null;
};

export const getWispDomainInfo = async (did: string) => {
    const rows = await db`SELECT domain, rkey FROM domains WHERE did = ${did}`;
    return rows[0] ?? null;
};

export const getDidByDomain = async (domain: string): Promise<string | null> => {
    const rows = await db`SELECT did FROM domains WHERE domain = ${domain.toLowerCase()}`;
    return rows[0]?.did ?? null;
};

export const isDomainAvailable = async (handle: string): Promise<boolean> => {
    const h = handle.trim().toLowerCase();
    if (!isValidHandle(h)) return false;
    const domain = toDomain(h);
    const rows = await db`SELECT 1 FROM domains WHERE domain = ${domain} LIMIT 1`;
    return rows.length === 0;
};

export const isDomainRegistered = async (domain: string) => {
    const domainLower = domain.toLowerCase().trim();

    // Check wisp.place subdomains
    const wispDomain = await db`
        SELECT did, domain, rkey FROM domains WHERE domain = ${domainLower}
    `;

    if (wispDomain.length > 0) {
        return {
            registered: true,
            type: 'wisp' as const,
            domain: wispDomain[0].domain,
            did: wispDomain[0].did,
            rkey: wispDomain[0].rkey
        };
    }

    // Check custom domains
    const customDomain = await db`
        SELECT id, domain, did, rkey, verified FROM custom_domains WHERE domain = ${domainLower}
    `;

    if (customDomain.length > 0) {
        return {
            registered: true,
            type: 'custom' as const,
            domain: customDomain[0].domain,
            did: customDomain[0].did,
            rkey: customDomain[0].rkey,
            verified: customDomain[0].verified
        };
    }

    return { registered: false };
};

export const claimDomain = async (did: string, handle: string): Promise<string> => {
    const h = handle.trim().toLowerCase();
    if (!isValidHandle(h)) throw new Error('invalid_handle');
    const domain = toDomain(h);
    try {
        await db`
            INSERT INTO domains (domain, did)
            VALUES (${domain}, ${did})
        `;
    } catch (err) {
        // Unique constraint violations -> already taken or DID already claimed
        throw new Error('conflict');
    }
    return domain;
};

export const updateDomain = async (did: string, handle: string): Promise<string> => {
    const h = handle.trim().toLowerCase();
    if (!isValidHandle(h)) throw new Error('invalid_handle');
    const domain = toDomain(h);
    try {
        const rows = await db`
            UPDATE domains SET domain = ${domain}
            WHERE did = ${did}
            RETURNING domain
        `;
        if (rows.length > 0) return rows[0].domain as string;
        // No existing row, behave like claim
        return await claimDomain(did, handle);
    } catch (err) {
        // Unique constraint violations -> already taken by someone else
        throw new Error('conflict');
    }
};

export const updateWispDomainSite = async (did: string, siteRkey: string | null): Promise<void> => {
    await db`
        UPDATE domains
        SET rkey = ${siteRkey}
        WHERE did = ${did}
    `;
};

export const getWispDomainSite = async (did: string): Promise<string | null> => {
    const rows = await db`SELECT rkey FROM domains WHERE did = ${did}`;
    return rows[0]?.rkey ?? null;
};

const stateStore = {
    async set(key: string, data: any) {
        console.debug('[stateStore] set', key)
        await db`
            INSERT INTO oauth_states (key, data)
            VALUES (${key}, ${JSON.stringify(data)})
            ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data
        `;
    },
    async get(key: string) {
        console.debug('[stateStore] get', key)
        const result = await db`SELECT data FROM oauth_states WHERE key = ${key}`;
        return result[0] ? JSON.parse(result[0].data) : undefined;
    },
    async del(key: string) {
        console.debug('[stateStore] del', key)
        await db`DELETE FROM oauth_states WHERE key = ${key}`;
    }
};

const sessionStore = {
    async set(sub: string, data: any) {
        console.debug('[sessionStore] set', sub)
        await db`
            INSERT INTO oauth_sessions (sub, data)
            VALUES (${sub}, ${JSON.stringify(data)})
            ON CONFLICT (sub) DO UPDATE SET data = EXCLUDED.data, updated_at = EXTRACT(EPOCH FROM NOW())
        `;
    },
    async get(sub: string) {
        console.debug('[sessionStore] get', sub)
        const result = await db`SELECT data FROM oauth_sessions WHERE sub = ${sub}`;
        return result[0] ? JSON.parse(result[0].data) : undefined;
    },
    async del(sub: string) {
        console.debug('[sessionStore] del', sub)
        await db`DELETE FROM oauth_sessions WHERE sub = ${sub}`;
    }
};

export { sessionStore };

export const createClientMetadata = (config: { domain: `https://${string}`, clientName: string }): ClientMetadata => ({
    client_id: `${config.domain}/client-metadata.json`,
    client_name: config.clientName,
    client_uri: config.domain,
    logo_uri: `${config.domain}/logo.png`,
    tos_uri: `${config.domain}/tos`,
    policy_uri: `${config.domain}/policy`,
    redirect_uris: [`${config.domain}/api/auth/callback`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: "ES256",
    scope: "atproto transition:generic",
    dpop_bound_access_tokens: true,
    jwks_uri: `${config.domain}/jwks.json`,
    subject_type: 'public',
    authorization_signed_response_alg: 'ES256'
});

const persistKey = async (key: JoseKey) => {
    const priv = key.privateJwk;
    if (!priv) return;
    const kid = key.kid ?? crypto.randomUUID();
    await db`
        INSERT INTO oauth_keys (kid, jwk)
        VALUES (${kid}, ${JSON.stringify(priv)})
        ON CONFLICT (kid) DO UPDATE SET jwk = EXCLUDED.jwk
    `;
};

const loadPersistedKeys = async (): Promise<JoseKey[]> => {
    const rows = await db`SELECT kid, jwk FROM oauth_keys ORDER BY kid`;
    const keys: JoseKey[] = [];
    for (const row of rows) {
        try {
            const obj = JSON.parse(row.jwk);
            const key = await JoseKey.fromImportable(obj as any, (obj as any).kid);
            keys.push(key);
        } catch (err) {
            console.error('Could not parse stored JWK', err);
        }
    }
    return keys;
};

const ensureKeys = async (): Promise<JoseKey[]> => {
    let keys = await loadPersistedKeys();
    const needed: string[] = [];
    for (let i = 1; i <= 3; i++) {
        const kid = `key${i}`;
        if (!keys.some(k => k.kid === kid)) needed.push(kid);
    }
    for (const kid of needed) {
        const newKey = await JoseKey.generate(['ES256'], kid);
        await persistKey(newKey);
        keys.push(newKey);
    }
    keys.sort((a, b) => (a.kid ?? '').localeCompare(b.kid ?? ''));
    return keys;
};

let currentKeys: JoseKey[] = [];

export const getCurrentKeys = () => currentKeys;

export const getOAuthClient = async (config: { domain: `https://${string}`, clientName: string }) => {
    if (currentKeys.length === 0) {
        currentKeys = await ensureKeys();
    }

    return new NodeOAuthClient({
        clientMetadata: createClientMetadata(config),
        keyset: currentKeys,
        stateStore,
        sessionStore
    });
};

export const getCustomDomainsByDid = async (did: string) => {
    const rows = await db`SELECT * FROM custom_domains WHERE did = ${did} ORDER BY created_at DESC`;
    return rows;
};

export const getCustomDomainInfo = async (domain: string) => {
    const rows = await db`SELECT * FROM custom_domains WHERE domain = ${domain.toLowerCase()}`;
    return rows[0] ?? null;
};

export const getCustomDomainByHash = async (hash: string) => {
    const rows = await db`SELECT * FROM custom_domains WHERE id = ${hash}`;
    return rows[0] ?? null;
};

export const getCustomDomainById = async (id: string) => {
    const rows = await db`SELECT * FROM custom_domains WHERE id = ${id}`;
    return rows[0] ?? null;
};

export const claimCustomDomain = async (did: string, domain: string, hash: string, rkey: string = 'self') => {
    const domainLower = domain.toLowerCase();
    try {
        await db`
            INSERT INTO custom_domains (id, domain, did, rkey, verified, created_at)
            VALUES (${hash}, ${domainLower}, ${did}, ${rkey}, false, EXTRACT(EPOCH FROM NOW()))
        `;
        return { success: true, hash };
    } catch (err) {
        console.error('Failed to claim custom domain', err);
        throw new Error('conflict');
    }
};

export const updateCustomDomainRkey = async (id: string, rkey: string) => {
    const rows = await db`
        UPDATE custom_domains
        SET rkey = ${rkey}
        WHERE id = ${id}
        RETURNING *
    `;
    return rows[0] ?? null;
};

export const updateCustomDomainVerification = async (id: string, verified: boolean) => {
    const rows = await db`
        UPDATE custom_domains
        SET verified = ${verified}, last_verified_at = EXTRACT(EPOCH FROM NOW())
        WHERE id = ${id}
        RETURNING *
    `;
    return rows[0] ?? null;
};

export const deleteCustomDomain = async (id: string) => {
    await db`DELETE FROM custom_domains WHERE id = ${id}`;
};

export const getSitesByDid = async (did: string) => {
    const rows = await db`SELECT * FROM sites WHERE did = ${did} ORDER BY created_at DESC`;
    return rows;
};

export const upsertSite = async (did: string, rkey: string, displayName?: string) => {
    try {
        // Only set display_name if provided (not undefined/null/empty)
        const cleanDisplayName = displayName && displayName.trim() ? displayName.trim() : null;

        await db`
            INSERT INTO sites (did, rkey, display_name, created_at, updated_at)
            VALUES (${did}, ${rkey}, ${cleanDisplayName}, EXTRACT(EPOCH FROM NOW()), EXTRACT(EPOCH FROM NOW()))
            ON CONFLICT (did, rkey)
            DO UPDATE SET
                display_name = CASE
                    WHEN EXCLUDED.display_name IS NOT NULL THEN EXCLUDED.display_name
                    ELSE sites.display_name
                END,
                updated_at = EXTRACT(EPOCH FROM NOW())
        `;
        return { success: true };
    } catch (err) {
        console.error('Failed to upsert site', err);
        return { success: false, error: err };
    }
};
