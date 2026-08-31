export type DatabaseReadEndpointMode =
	| 'primary'
	| 'healthy'
	| 'unavailable'
	| 'lagging'
	| 'receiver_unhealthy'
	| 'writable'
	| 'unsafe'

export interface DatabaseReadProbeResult {
	transactionReadOnly: boolean
	sensitiveDataRestricted: boolean
	writePrivilegesRestricted: boolean
	inRecovery: boolean
	replicationReceiverHealthy: boolean
	replayLagMs: number | null
}

export interface DatabaseReadEndpointHealth {
	configured: boolean
	mode: DatabaseReadEndpointMode
	usingPrimaryFallback: boolean
	transactionReadOnly?: boolean
	sensitiveDataRestricted?: boolean
	writePrivilegesRestricted?: boolean
	inRecovery?: boolean
	replicationReceiverHealthy?: boolean
	replayLagMs?: number | null
	lastCheckedAt?: string
	nextProbeAt?: string
	consecutiveFailures: number
}

export interface DatabaseReadCircuitOptions {
	configured: boolean
	maxReplayLagMs: number
	probeIntervalMs: number
	cooldownMs: number
	probe: () => Promise<DatabaseReadProbeResult>
	now?: () => number
}

export interface DatabaseReadCircuit {
	probeNow(): Promise<DatabaseReadEndpointHealth>
	health(): Promise<DatabaseReadEndpointHealth>
	withRead<T>(replicaRead: () => Promise<T>, primaryRead: () => Promise<T>): Promise<T>
	recordReadFailure(): void
	snapshot(): DatabaseReadEndpointHealth
}

/**
 * Keeps presentation reads on a replica only while its bounded probe is healthy.
 * Probe attempts are single-flight and cooldown-gated so a failed endpoint cannot
 * create a request-driven retry storm.
 */
export const createDatabaseReadCircuit = (options: DatabaseReadCircuitOptions): DatabaseReadCircuit => {
	const now = options.now ?? Date.now
	let mode: DatabaseReadEndpointMode = options.configured ? 'unavailable' : 'primary'
	let transactionReadOnly: boolean | undefined
	let sensitiveDataRestricted: boolean | undefined
	let writePrivilegesRestricted: boolean | undefined
	let inRecovery: boolean | undefined
	let replicationReceiverHealthy: boolean | undefined
	let replayLagMs: number | null | undefined
	let lastCheckedAt: number | undefined
	let nextProbeAt = 0
	let consecutiveFailures = 0
	let activeProbe: Promise<DatabaseReadEndpointHealth> | undefined

	const snapshot = (): DatabaseReadEndpointHealth => ({
		configured: options.configured,
		mode,
		usingPrimaryFallback: options.configured && mode !== 'healthy',
		transactionReadOnly,
		sensitiveDataRestricted,
		writePrivilegesRestricted,
		inRecovery,
		replicationReceiverHealthy,
		replayLagMs,
		lastCheckedAt: lastCheckedAt === undefined ? undefined : new Date(lastCheckedAt).toISOString(),
		nextProbeAt: nextProbeAt === 0 ? undefined : new Date(nextProbeAt).toISOString(),
		consecutiveFailures,
	})

	const markUnavailable = (): void => {
		mode = 'unavailable'
		consecutiveFailures++
		lastCheckedAt = now()
		nextProbeAt = lastCheckedAt + options.cooldownMs
	}

	const applyProbe = (result: DatabaseReadProbeResult): void => {
		transactionReadOnly = result.transactionReadOnly
		sensitiveDataRestricted = result.sensitiveDataRestricted
		writePrivilegesRestricted = result.writePrivilegesRestricted
		inRecovery = result.inRecovery
		replicationReceiverHealthy = result.replicationReceiverHealthy
		replayLagMs = result.replayLagMs
		lastCheckedAt = now()

		if (!result.transactionReadOnly) {
			mode = 'writable'
			consecutiveFailures++
			nextProbeAt = lastCheckedAt + options.cooldownMs
			return
		}

		if (!result.sensitiveDataRestricted || !result.writePrivilegesRestricted) {
			mode = 'unsafe'
			consecutiveFailures++
			nextProbeAt = lastCheckedAt + options.cooldownMs
			return
		}

		if (result.inRecovery && !result.replicationReceiverHealthy) {
			mode = 'receiver_unhealthy'
			consecutiveFailures++
			nextProbeAt = lastCheckedAt + options.cooldownMs
			return
		}

		if (result.inRecovery && (result.replayLagMs === null || result.replayLagMs > options.maxReplayLagMs)) {
			mode = 'lagging'
			consecutiveFailures++
			nextProbeAt = lastCheckedAt + options.cooldownMs
			return
		}

		mode = 'healthy'
		consecutiveFailures = 0
		nextProbeAt = lastCheckedAt + options.probeIntervalMs
	}

	const probeIfDue = async (force: boolean): Promise<DatabaseReadEndpointHealth> => {
		if (!options.configured) return snapshot()
		if (activeProbe) return activeProbe
		if (!force && now() < nextProbeAt) return snapshot()

		activeProbe = (async () => {
			try {
				applyProbe(await options.probe())
			} catch {
				// Do not retain or expose a driver error; callers fall back to primary.
				markUnavailable()
			}
			return snapshot()
		})()

		try {
			return await activeProbe
		} finally {
			activeProbe = undefined
		}
	}

	return {
		probeNow: () => probeIfDue(true),
		health: () => probeIfDue(false),
		snapshot,
		recordReadFailure: markUnavailable,
		async withRead<T>(replicaRead: () => Promise<T>, primaryRead: () => Promise<T>): Promise<T> {
			const health = await probeIfDue(false)
			if (health.mode !== 'healthy') return await primaryRead()

			try {
				return await replicaRead()
			} catch {
				markUnavailable()
				return await primaryRead()
			}
		},
	}
}
