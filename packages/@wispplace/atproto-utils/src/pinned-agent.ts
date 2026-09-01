/**
 * Keep-alive connection pooling for DNS-pinned transports.
 *
 * The pinned transports resolve and validate every DNS answer before
 * connecting, then hand the chosen address to Node's `lookup` hook. Passing
 * `agent: false` alongside that made every request pay a fresh TCP and TLS
 * handshake. On a long path — a Singapore node talking to a PDS in the United
 * States — that handshake measured between 0.6s and 6.8s per request, while a
 * reused socket answered the same request in 0.24s. An OAuth login makes five
 * to eight of those calls, so the handshakes, not the work, were the latency.
 *
 * Reuse does not weaken the address pinning. A pooled socket is already
 * connected to an address that passed validation, so it cannot be re-pointed by
 * a later DNS answer.
 *
 * The pooling key must carry the pinned address. Node builds its socket-pool
 * name from host, port, family, and the TLS options — never from the `lookup`
 * hook — so one agent shared across two addresses for the same hostname would
 * hand out a socket connected to the wrong one. Every distinct address gets its
 * own agent instead.
 */
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'

export type PinnedAgentFamily = 4 | 6

export interface PinnedAgentAddress {
	address: string
	family: PinnedAgentFamily
}

/** How long an unused socket is held open for the next request. */
const KEEP_ALIVE_MS = 30_000
/** Concurrent sockets per hostname/address pair. */
const MAX_SOCKETS = 32
/** Idle sockets retained per hostname/address pair. */
const MAX_FREE_SOCKETS = 4
/**
 * Distinct hostname/address pairs kept alive. Destinations are remote and
 * caller-influenced, so the map is bounded and evicts least-recently-used.
 */
const MAX_AGENTS = 256

const agents = new Map<string, HttpAgent | HttpsAgent>()

const agentOptions = {
	keepAlive: true,
	keepAliveMsecs: KEEP_ALIVE_MS,
	maxSockets: MAX_SOCKETS,
	maxFreeSockets: MAX_FREE_SOCKETS,
	// An idle pooled socket is closed rather than kept indefinitely. This bounds
	// how long a connection to a since-changed DNS answer can survive.
	timeout: KEEP_ALIVE_MS,
	scheduling: 'lifo' as const,
}

function evictOldest(): void {
	// Map iteration is insertion-ordered and every hit re-inserts, so the first
	// entry is the least recently used.
	const oldest = agents.keys().next()
	if (oldest.done) return
	const evicted = agents.get(oldest.value)
	agents.delete(oldest.value)
	evicted?.destroy()
}

/**
 * The keep-alive agent for one origin reached at one validated address.
 *
 * Node merges the agent's own options over the request's, so this deliberately
 * sets no `lookup`: the caller's pinned hook is what opens the socket.
 */
export function pinnedKeepAliveAgent(url: URL, address: PinnedAgentAddress): HttpAgent | HttpsAgent {
	const secure = url.protocol === 'https:'
	const port = url.port || (secure ? '443' : '80')
	const key = `${url.protocol}//${url.hostname}:${port}#${address.family}#${address.address}`

	const existing = agents.get(key)
	if (existing) {
		// Re-insert so this key becomes the most recently used.
		agents.delete(key)
		agents.set(key, existing)
		return existing
	}

	if (agents.size >= MAX_AGENTS) evictOldest()

	const created = secure ? new HttpsAgent(agentOptions) : new HttpAgent(agentOptions)
	agents.set(key, created)
	return created
}

/** Close every pooled socket. Used by graceful shutdown and by tests. */
export function closePinnedKeepAliveAgents(): void {
	for (const agent of agents.values()) agent.destroy()
	agents.clear()
}
