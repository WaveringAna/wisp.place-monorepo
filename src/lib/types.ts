import type { BlobRef } from "@atproto/api";

/**
 * Configuration for the Wisp client
 * @typeParam Config
 */
export type Config = {
    /** The base domain URL with HTTPS protocol */
    domain: `https://${string}`,
    /** Name of the client application */
    clientName: string
};
