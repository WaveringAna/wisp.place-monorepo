import { NodeOAuthClient, type ClientMetadata } from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import { db } from "./db";
import { logger } from "./logger";
import { SlingshotHandleResolver } from "./slingshot-handle-resolver";

// Session timeout configuration (30 days in seconds)
const SESSION_TIMEOUT = 30 * 24 * 60 * 60; // 2592000 seconds
// OAuth state timeout (1 hour in seconds)
const STATE_TIMEOUT = 60 * 60; // 3600 seconds

const stateStore = {
    async set(key: string, data: any) {
        console.debug('[stateStore] set', key)
        const expiresAt = Math.floor(Date.now() / 1000) + STATE_TIMEOUT;
        await db`
            INSERT INTO oauth_states (key, data, created_at, expires_at)
            VALUES (${key}, ${JSON.stringify(data)}, EXTRACT(EPOCH FROM NOW()), ${expiresAt})
            ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, expires_at = ${expiresAt}
        `;
    },
    async get(key: string) {
        console.debug('[stateStore] get', key)
        const now = Math.floor(Date.now() / 1000);
        const result = await db`
            SELECT data, expires_at
            FROM oauth_states
            WHERE key = ${key}
        `;
        if (!result[0]) return undefined;

        // Check if expired
        const expiresAt = Number(result[0].expires_at);
        if (expiresAt && now > expiresAt) {
            console.debug('[stateStore] State expired, deleting', key);
            await db`DELETE FROM oauth_states WHERE key = ${key}`;
            return undefined;
        }

        return JSON.parse(result[0].data);
    },
    async del(key: string) {
        console.debug('[stateStore] del', key)
        await db`DELETE FROM oauth_states WHERE key = ${key}`;
    }
};

const sessionStore = {
    async set(sub: string, data: any) {
        console.debug('[sessionStore] set', sub)
        const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TIMEOUT;
        await db`
            INSERT INTO oauth_sessions (sub, data, updated_at, expires_at)
            VALUES (${sub}, ${JSON.stringify(data)}, EXTRACT(EPOCH FROM NOW()), ${expiresAt})
            ON CONFLICT (sub) DO UPDATE SET
                data = EXCLUDED.data,
                updated_at = EXTRACT(EPOCH FROM NOW()),
                expires_at = ${expiresAt}
        `;
    },
    async get(sub: string) {
        const now = Math.floor(Date.now() / 1000);
        const result = await db`
            SELECT data, expires_at
            FROM oauth_sessions
            WHERE sub = ${sub}
        `;
        if (!result[0]) return undefined;

        // Check if expired
        const expiresAt = Number(result[0].expires_at);
        if (expiresAt && now > expiresAt) {
            logger.debug('[sessionStore] Session expired, deleting', sub);
            await db`DELETE FROM oauth_sessions WHERE sub = ${sub}`;
            return undefined;
        }

        return JSON.parse(result[0].data);
    },
    async del(sub: string) {
        console.debug('[sessionStore] del', sub)
        await db`DELETE FROM oauth_sessions WHERE sub = ${sub}`;
    }
};

export { sessionStore };

// Cleanup expired sessions and states
export const cleanupExpiredSessions = async () => {
    const now = Math.floor(Date.now() / 1000);
    try {
        const sessionsDeleted = await db`
            DELETE FROM oauth_sessions WHERE expires_at < ${now}
        `;
        const statesDeleted = await db`
            DELETE FROM oauth_states WHERE expires_at IS NOT NULL AND expires_at < ${now}
        `;
        logger.info(`[Cleanup] Deleted ${sessionsDeleted.length} expired sessions and ${statesDeleted.length} expired states`);
        return { sessions: sessionsDeleted.length, states: statesDeleted.length };
    } catch (err) {
        logger.error('[Cleanup] Failed to cleanup expired data', err);
        return { sessions: 0, states: 0 };
    }
};

export const createClientMetadata = (config: { domain: `http://${string}` | `https://${string}`, clientName: string }): ClientMetadata => {
    const isLocalDev = Bun.env.LOCAL_DEV === 'true';

    if (isLocalDev) {
        // Loopback client for local development
        // For loopback, scopes and redirect_uri must be in client_id query string
        const redirectUri = 'http://127.0.0.1:8000/api/auth/callback';
        const scope = 'atproto transition:generic';
        const params = new URLSearchParams();
        params.append('redirect_uri', redirectUri);
        params.append('scope', scope);

        return {
            client_id: `http://localhost?${params.toString()}`,
            client_name: config.clientName,
            client_uri: `https://wisp.place`,
            redirect_uris: [redirectUri],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            application_type: 'web',
            token_endpoint_auth_method: 'none',
            scope: scope,
            dpop_bound_access_tokens: false,
            subject_type: 'public'
        };
    }

    // Production client with private_key_jwt
    return {
        client_id: `${config.domain}/client-metadata.json`,
        client_name: config.clientName,
        client_uri: `https://wisp.place`,
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
    };
};

const persistKey = async (key: JoseKey) => {
    const priv = key.privateJwk;
    if (!priv) return;
    const kid = key.kid ?? crypto.randomUUID();
    await db`
        INSERT INTO oauth_keys (kid, jwk, created_at)
        VALUES (${kid}, ${JSON.stringify(priv)}, EXTRACT(EPOCH FROM NOW()))
        ON CONFLICT (kid) DO UPDATE SET jwk = EXCLUDED.jwk
    `;
};

const loadPersistedKeys = async (): Promise<JoseKey[]> => {
    const rows = await db`SELECT kid, jwk, created_at FROM oauth_keys ORDER BY kid`;
    const keys: JoseKey[] = [];
    for (const row of rows) {
        try {
            const obj = JSON.parse(row.jwk);
            const key = await JoseKey.fromImportable(obj as any, (obj as any).kid);
            keys.push(key);
        } catch (err) {
            logger.error('[OAuth] Could not parse stored JWK', err);
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

// Load keys from database every time (stateless - safe for horizontal scaling)
export const getCurrentKeys = async (): Promise<JoseKey[]> => {
    return await loadPersistedKeys();
};

// Key rotation - rotate keys older than 30 days (monthly rotation)
const KEY_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export const rotateKeysIfNeeded = async (): Promise<boolean> => {
    const now = Math.floor(Date.now() / 1000);
    const cutoffTime = now - KEY_MAX_AGE;

    try {
        // Find keys older than 30 days
        const oldKeys = await db`
            SELECT kid, created_at FROM oauth_keys
            WHERE created_at IS NOT NULL AND created_at < ${cutoffTime}
            ORDER BY created_at ASC
        `;

        if (oldKeys.length === 0) {
            logger.debug('[KeyRotation] No keys need rotation');
            return false;
        }

        logger.info(`[KeyRotation] Found ${oldKeys.length} key(s) older than 30 days, rotating oldest key`);

        // Rotate the oldest key
        const oldestKey = oldKeys[0];
        const oldKid = oldestKey.kid;

        // Generate new key with same kid
        const newKey = await JoseKey.generate(['ES256'], oldKid);
        await persistKey(newKey);

        logger.info(`[KeyRotation] Rotated key ${oldKid}`);

        return true;
    } catch (err) {
        logger.error('[KeyRotation] Failed to rotate keys', err);
        return false;
    }
};

export const getOAuthClient = async (config: { domain: `http://${string}` | `https://${string}`, clientName: string }) => {
    const keys = await ensureKeys();

    return new NodeOAuthClient({
        clientMetadata: createClientMetadata(config),
        keyset: keys,
        stateStore,
        sessionStore,
        handleResolver: new SlingshotHandleResolver()
    });
};
