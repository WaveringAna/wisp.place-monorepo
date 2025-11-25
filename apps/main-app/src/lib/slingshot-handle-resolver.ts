import type { HandleResolver, ResolveHandleOptions, ResolvedHandle } from '@atproto-labs/handle-resolver';
import type { AtprotoDid } from '@atproto/did';
import { logger } from './logger';

/**
 * Custom HandleResolver that uses Slingshot's identity resolver service
 * to work around bugs in atproto-oauth-node when handles have redirects
 * in their well-known configuration.
 *
 * Uses: https://slingshot.wisp.place/xrpc/com.atproto.identity.resolveHandle
 */
export class SlingshotHandleResolver implements HandleResolver {
    private readonly endpoint = 'https://slingshot.wisp.place/xrpc/com.atproto.identity.resolveHandle';

    async resolve(handle: string, options?: ResolveHandleOptions): Promise<ResolvedHandle> {
        try {
            logger.debug('[SlingshotHandleResolver] Resolving handle', { handle });

            const url = new URL(this.endpoint);
            url.searchParams.set('handle', handle);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

            try {
                const response = await fetch(url.toString(), {
                    signal: options?.signal || controller.signal,
                    headers: {
                        'Accept': 'application/json',
                    },
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    logger.error('[SlingshotHandleResolver] Failed to resolve handle', {
                        handle,
                        status: response.status,
                        statusText: response.statusText,
                    });
                    return null;
                }

                const data = await response.json() as { did: string };

                if (!data.did) {
                    logger.warn('[SlingshotHandleResolver] No DID in response', { handle });
                    return null;
                }

                // Validate that it's a proper DID format
                if (!data.did.startsWith('did:')) {
                    logger.error('[SlingshotHandleResolver] Invalid DID format', { handle, did: data.did });
                    return null;
                }

                logger.debug('[SlingshotHandleResolver] Successfully resolved handle', { handle, did: data.did });
                return data.did as AtprotoDid;
            } catch (fetchError) {
                clearTimeout(timeoutId);

                if (fetchError instanceof Error && fetchError.name === 'AbortError') {
                    logger.error('[SlingshotHandleResolver] Request aborted', { handle });
                    throw fetchError; // Re-throw abort errors
                }

                throw fetchError;
            }
        } catch (error) {
            logger.error('[SlingshotHandleResolver] Error resolving handle', error, { handle });

            // If it's an abort error, propagate it
            if (error instanceof Error && error.name === 'AbortError') {
                throw error;
            }

            // For other unexpected errors, return null (handle not found)
            return null;
        }
    }
}
