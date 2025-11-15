import { SQL } from "bun";
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
        updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()),
        expires_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) + 2592000
    )
`;

await db`
    CREATE TABLE IF NOT EXISTS oauth_keys (
        kid TEXT PRIMARY KEY,
        jwk TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
`;

// Cookie secrets table for signed cookies
await db`
    CREATE TABLE IF NOT EXISTS cookie_secrets (
        id TEXT PRIMARY KEY DEFAULT 'default',
        secret TEXT NOT NULL,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
`;

// Domains table maps subdomain -> DID (now supports up to 3 domains per user)
await db`
    CREATE TABLE IF NOT EXISTS domains (
        domain TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        rkey TEXT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
`;

// Add columns if they don't exist (for existing databases)
try {
    await db`ALTER TABLE domains ADD COLUMN IF NOT EXISTS rkey TEXT`;
} catch (err) {
    // Column might already exist, ignore
}

try {
    await db`ALTER TABLE oauth_sessions ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) + 2592000`;
} catch (err) {
    // Column might already exist, ignore
}

try {
    await db`ALTER TABLE oauth_keys ADD COLUMN IF NOT EXISTS created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())`;
} catch (err) {
    // Column might already exist, ignore
}

try {
    await db`ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS expires_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) + 3600`;
} catch (err) {
    // Column might already exist, ignore
}

// Remove the unique constraint on domains.did to allow multiple domains per user
try {
    await db`ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_did_key`;
} catch (err) {
    // Constraint might already be removed, ignore
}

// Custom domains table for BYOD (bring your own domain)
await db`
    CREATE TABLE IF NOT EXISTS custom_domains (
        id TEXT PRIMARY KEY,
        domain TEXT UNIQUE NOT NULL,
        did TEXT NOT NULL,
        rkey TEXT,
        verified BOOLEAN DEFAULT false,
        last_verified_at BIGINT,
        created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())
    )
`;

// Migrate existing tables to make rkey nullable and remove default
try {
    await db`ALTER TABLE custom_domains ALTER COLUMN rkey DROP NOT NULL`;
} catch (err) {
    // Column might already be nullable, ignore
}
try {
    await db`ALTER TABLE custom_domains ALTER COLUMN rkey DROP DEFAULT`;
} catch (err) {
    // Default might already be removed, ignore
}

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

// Create indexes for common query patterns
await Promise.all([
    // oauth_states cleanup queries
    db`CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at ON oauth_states(expires_at)`.catch(err => {
        if (!err.message?.includes('already exists')) {
            console.error('Failed to create idx_oauth_states_expires_at:', err);
        }
    }),

    // oauth_sessions cleanup queries
    db`CREATE INDEX IF NOT EXISTS idx_oauth_sessions_expires_at ON oauth_sessions(expires_at)`.catch(err => {
        if (!err.message?.includes('already exists')) {
            console.error('Failed to create idx_oauth_sessions_expires_at:', err);
        }
    }),

    // oauth_keys key rotation queries
    db`CREATE INDEX IF NOT EXISTS idx_oauth_keys_created_at ON oauth_keys(created_at)`.catch(err => {
        if (!err.message?.includes('already exists')) {
            console.error('Failed to create idx_oauth_keys_created_at:', err);
        }
    }),

    // domains queries by (did, rkey)
    db`CREATE INDEX IF NOT EXISTS idx_domains_did_rkey ON domains(did, rkey)`.catch(err => {
        if (!err.message?.includes('already exists')) {
            console.error('Failed to create idx_domains_did_rkey:', err);
        }
    }),

    // custom_domains queries by did
    db`CREATE INDEX IF NOT EXISTS idx_custom_domains_did ON custom_domains(did)`.catch(err => {
        if (!err.message?.includes('already exists')) {
            console.error('Failed to create idx_custom_domains_did:', err);
        }
    }),

    // custom_domains queries by (did, rkey)
    db`CREATE INDEX IF NOT EXISTS idx_custom_domains_did_rkey ON custom_domains(did, rkey)`.catch(err => {
        if (!err.message?.includes('already exists')) {
            console.error('Failed to create idx_custom_domains_did_rkey:', err);
        }
    }),

    // custom_domains DNS verification worker queries
    db`CREATE INDEX IF NOT EXISTS idx_custom_domains_verified ON custom_domains(verified)`.catch(err => {
        if (!err.message?.includes('already exists')) {
            console.error('Failed to create idx_custom_domains_verified:', err);
        }
    }),

    // sites queries by did
    db`CREATE INDEX IF NOT EXISTS idx_sites_did ON sites(did)`.catch(err => {
        if (!err.message?.includes('already exists')) {
            console.error('Failed to create idx_sites_did:', err);
        }
    })
]);

const RESERVED_HANDLES = new Set([
    "www",
    "api",
    "admin",
    "static",
    "public",
    "preview",
    "slingshot",
    "plc",
    "constellation",
    "cdn",
    "pds",
    "staging",
    "auth"
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
    const rows = await db`SELECT domain FROM domains WHERE did = ${did} ORDER BY created_at ASC LIMIT 1`;
    return rows[0]?.domain ?? null;
};

export const getWispDomainInfo = async (did: string) => {
    const rows = await db`SELECT domain, rkey FROM domains WHERE did = ${did} ORDER BY created_at ASC LIMIT 1`;
    return rows[0] ?? null;
};

export const getAllWispDomains = async (did: string): Promise<Array<{ domain: string; rkey: string | null }>> => {
    const rows = await db`SELECT domain, rkey FROM domains WHERE did = ${did} ORDER BY created_at ASC`;
    return rows;
};

export const countWispDomains = async (did: string): Promise<number> => {
    const rows = await db`SELECT COUNT(*) as count FROM domains WHERE did = ${did}`;
    return Number(rows[0]?.count ?? 0);
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

    // Check if user already has 3 domains
    const existingCount = await countWispDomains(did);
    if (existingCount >= 3) {
        throw new Error('domain_limit_reached');
    }

    const domain = toDomain(h);
    try {
        await db`
            INSERT INTO domains (domain, did)
            VALUES (${domain}, ${did})
        `;
    } catch (err) {
        // Unique constraint violations -> already taken
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

export const updateWispDomainSite = async (domain: string, siteRkey: string | null): Promise<void> => {
    await db`
        UPDATE domains
        SET rkey = ${siteRkey}
        WHERE domain = ${domain}
    `;
};

export const getWispDomainSite = async (did: string): Promise<string | null> => {
    const rows = await db`SELECT rkey FROM domains WHERE did = ${did} ORDER BY created_at ASC LIMIT 1`;
    return rows[0]?.rkey ?? null;
};

export const deleteWispDomain = async (domain: string): Promise<void> => {
    await db`DELETE FROM domains WHERE domain = ${domain}`;
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

export const claimCustomDomain = async (did: string, domain: string, hash: string, rkey: string | null = null) => {
    const domainLower = domain.toLowerCase();
    try {
        // Use UPSERT with ON CONFLICT to handle existing pending domains
        const result = await db`
            INSERT INTO custom_domains (id, domain, did, rkey, verified, created_at)
            VALUES (${hash}, ${domainLower}, ${did}, ${rkey}, false, EXTRACT(EPOCH FROM NOW()))
            ON CONFLICT (domain) DO UPDATE SET
                id = EXCLUDED.id,
                did = EXCLUDED.did,
                rkey = EXCLUDED.rkey,
                verified = EXCLUDED.verified,
                created_at = EXCLUDED.created_at
            WHERE custom_domains.verified = false
            RETURNING *
        `;
        
        if (result.length === 0) {
            // No rows were updated, meaning the domain exists and is verified
            throw new Error('conflict');
        }
        
        return { success: true, hash };
    } catch (err) {
        console.error('Failed to claim custom domain', err);
        throw new Error('conflict');
    }
};

export const updateCustomDomainRkey = async (id: string, rkey: string | null) => {
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

export const deleteSite = async (did: string, rkey: string) => {
    try {
        await db`DELETE FROM sites WHERE did = ${did} AND rkey = ${rkey}`;
        return { success: true };
    } catch (err) {
        console.error('Failed to delete site', err);
        return { success: false, error: err };
    }
};

// Get all domains (wisp + custom) mapped to a specific site
export const getDomainsBySite = async (did: string, rkey: string) => {
    const domains: Array<{
        type: 'wisp' | 'custom';
        domain: string;
        verified?: boolean;
        id?: string;
    }> = [];

    // Check wisp domain
    const wispDomain = await db`
        SELECT domain, rkey FROM domains
        WHERE did = ${did} AND rkey = ${rkey}
    `;
    if (wispDomain.length > 0) {
        domains.push({
            type: 'wisp',
            domain: wispDomain[0].domain,
        });
    }

    // Check custom domains
    const customDomains = await db`
        SELECT id, domain, verified FROM custom_domains
        WHERE did = ${did} AND rkey = ${rkey}
        ORDER BY created_at DESC
    `;
    for (const cd of customDomains) {
        domains.push({
            type: 'custom',
            domain: cd.domain,
            verified: cd.verified,
            id: cd.id,
        });
    }

    return domains;
};

// Get count of domains mapped to a specific site
export const getDomainCountBySite = async (did: string, rkey: string) => {
    const wispCount = await db`
        SELECT COUNT(*) as count FROM domains
        WHERE did = ${did} AND rkey = ${rkey}
    `;

    const customCount = await db`
        SELECT COUNT(*) as count FROM custom_domains
        WHERE did = ${did} AND rkey = ${rkey}
    `;

    return {
        wisp: Number(wispCount[0]?.count || 0),
        custom: Number(customCount[0]?.count || 0),
        total: Number(wispCount[0]?.count || 0) + Number(customCount[0]?.count || 0),
    };
};

// Cookie secret management - ensure we have a secret for signing cookies
export const getCookieSecret = async (): Promise<string> => {
    // Check if secret already exists
    const rows = await db`SELECT secret FROM cookie_secrets WHERE id = 'default' LIMIT 1`;

    if (rows.length > 0) {
        return rows[0].secret as string;
    }

    // Generate new secret if none exists
    const secret = crypto.randomUUID() + crypto.randomUUID(); // 72 character random string
    await db`
        INSERT INTO cookie_secrets (id, secret, created_at)
        VALUES ('default', ${secret}, EXTRACT(EPOCH FROM NOW()))
    `;

    console.log('[CookieSecret] Generated new cookie signing secret');
    return secret;
};
