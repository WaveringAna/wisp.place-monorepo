import { Did } from "@atproto/api";
import { NodeOAuthClient } from "@atproto/oauth-client-node";
import type { OAuthSession } from "@atproto/oauth-client-node";
import { Cookie } from "elysia";
import { logger } from "./logger";


export interface AuthenticatedContext {
    did: Did;
    session: OAuthSession;
}

export const authenticateRequest = async (
    client: NodeOAuthClient,
    cookies: Record<string, Cookie<unknown>>
): Promise<AuthenticatedContext | null> => {
    try {
        const did = cookies.did?.value as Did;
        if (!did) return null;

        const session = await client.restore(did, "auto");
        return session ? { did, session } : null;
    } catch (err) {
        logger.error('[Auth] Authentication error', err);
        return null;
    }
};

export const requireAuth = async (
    client: NodeOAuthClient,
    cookies: Record<string, Cookie<unknown>>
): Promise<AuthenticatedContext> => {
    const auth = await authenticateRequest(client, cookies);
    if (!auth) {
        throw new Error('Authentication required');
    }
    return auth;
};
