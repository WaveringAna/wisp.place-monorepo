import { NodeOAuthClient, type ClientMetadata } from "@atproto/oauth-client-node";
import { JoseKey } from "@atproto/jwk-jose";
import { db } from "./db";

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

export const createClientMetadata = (config: { domain: `https://${string}`, clientName: string }): ClientMetadata => {
    // Use editor.wisp.place for OAuth endpoints since that's where the API routes live
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
