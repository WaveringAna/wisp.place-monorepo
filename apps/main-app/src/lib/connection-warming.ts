/**
 * Keeping database pools warm.
 *
 * A node in another region pays the full Postgres handshake on a cold
 * connection: TCP, the SSLRequest round trip, the TLS handshake, then three
 * more round trips for SCRAM-SHA-256 and one for startup. Measured from a
 * Singapore node to a primary in Ashburn that is about 1.9 seconds — more than
 * every query in a sign-in put together — and with a 30 second idle timeout the
 * pools were empty for almost every sign-in.
 */

/**
 * Touch a pool once, retrying a single time.
 *
 * A connection that reaches `maxLifetime` can be handed out and retired in the
 * same moment, which fails whichever query received it. That race is inherent
 * to recycling connections and is transient by construction: the retry is
 * served by a replacement connection.
 */
export const probeConnectionWithRetry = async (probe: () => Promise<unknown>): Promise<void> => {
	try {
		await probe()
	} catch {
		await probe()
	}
}

/**
 * How often to touch an idle pool, given its idle timeout.
 *
 * Comfortably inside that timeout, and frequent enough that a connection
 * retired at `maxLifetime` is replaced by the warming task rather than by a
 * user's request.
 */
export const resolveConnectionWarmingIntervalMs = (idleTimeoutSeconds: number): number =>
	Math.max(10_000, Math.floor(idleTimeoutSeconds * 1_000 * 0.5))
