/**
 * Configuration for the Wisp client
 * @typeParam Config
 */
export type Config = {
    /** The base domain URL with HTTP or HTTPS protocol */
    domain: `http://${string}` | `https://${string}`,
    /** Name of the client application */
    clientName: string
};
