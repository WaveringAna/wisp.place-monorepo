/**
 * Small dependency-injected lifecycle primitives. They keep the crash-sensitive
 * ordering testable without giving storage code access to database state.
 */

// A renewed writer owns a short durable lease. Each object write is separately
// bounded below this deadline, so a stalled process cannot overlap reaper work.
export const PRIVATE_SITE_STAGING_LEASE_MS = 5 * 60 * 1_000
export const PRIVATE_SITE_STORAGE_WRITE_TIMEOUT_MS = 60 * 1_000

if (PRIVATE_SITE_STORAGE_WRITE_TIMEOUT_MS >= PRIVATE_SITE_STAGING_LEASE_MS) {
	throw new Error('private storage write timeout must be shorter than the staging lease')
}
export interface FailedStagingCleanupOperations {
	markDeleting(): Promise<boolean>
	removeStorage(): Promise<number>
	finalizeDeletion(): Promise<boolean>
}

export type LifecycleCleanupPhase = 'markDeleting' | 'removeStorage' | 'finalizeDeletion'
export type LifecycleFailureReporter = (phase: LifecycleCleanupPhase, error: unknown) => void

export interface FailedStagingCleanupResult {
	claimed: boolean
	storageRemoved: boolean
	finalized: boolean
}

/**
 * The state transition is always first. If it cannot commit, storage is left
 * untouched because the outcome may be an already-published site.
 */
export const cleanupFailedStaging = async (
	operations: FailedStagingCleanupOperations,
	reportFailure: LifecycleFailureReporter,
): Promise<FailedStagingCleanupResult> => {
	let claimed: boolean
	try {
		claimed = await operations.markDeleting()
	} catch (error) {
		reportFailure('markDeleting', error)
		return { claimed: false, storageRemoved: false, finalized: false }
	}
	if (!claimed) return { claimed: false, storageRemoved: false, finalized: false }

	try {
		await operations.removeStorage()
	} catch (error) {
		reportFailure('removeStorage', error)
		return { claimed: true, storageRemoved: false, finalized: false }
	}

	try {
		const finalized = await operations.finalizeDeletion()
		return { claimed: true, storageRemoved: true, finalized }
	} catch (error) {
		reportFailure('finalizeDeletion', error)
		return { claimed: true, storageRemoved: true, finalized: false }
	}
}

export class StagedPrivateSiteNotPublishedError extends Error {
	constructor() {
		super('private site could not be published')
		this.name = 'StagedPrivateSiteNotPublishedError'
	}
}

export class StagedPrivateSiteLeaseLostError extends Error {
	constructor() {
		super('private site staging lease was lost')
		this.name = 'StagedPrivateSiteLeaseLostError'
	}
}

export interface PersistStagedPrivateSiteOperations<File, Site> {
	files: readonly File[]
	renewLease(): Promise<boolean>
	writeFile(file: File): Promise<void>
	markReady(): Promise<Site | null>
	cleanup: FailedStagingCleanupOperations
	reportCleanupFailure: LifecycleFailureReporter
}

/**
 * Writes every object while hidden, then performs the one ready transition.
 * An error from markReady is deliberately not cleaned up: its commit outcome
 * is unknown, and removing storage could damage a fully published site.
 */
export const persistStagedPrivateSite = async <File, Site>(
	operations: PersistStagedPrivateSiteOperations<File, Site>,
): Promise<Site> => {
	try {
		for (const file of operations.files) {
			// Renew before each bounded write. If a reaper already changed the
			// row to deleting, do not start a late write under its cleaned prefix.
			if (!(await operations.renewLease())) {
				throw new StagedPrivateSiteLeaseLostError()
			}
			await operations.writeFile(file)
		}
	} catch (error) {
		await cleanupFailedStaging(operations.cleanup, operations.reportCleanupFailure)
		throw error
	}

	const ready = await operations.markReady()
	if (ready) return ready

	await cleanupFailedStaging(operations.cleanup, operations.reportCleanupFailure)
	throw new StagedPrivateSiteNotPublishedError()
}

export interface ClaimedPrivateSite {
	siteId: string
}

export interface ClaimedDeletionCleanupOperations {
	removeStorage(siteId: string): Promise<number>
	finalizeDeletion(siteId: string): Promise<boolean>
}

export interface ClaimedDeletionCleanupResult {
	sites: number
	files: number
}

/** Deletes only rows that a database claim has already hidden. */
export const cleanupClaimedPrivateSites = async (
	sites: readonly ClaimedPrivateSite[],
	operations: ClaimedDeletionCleanupOperations,
	reportFailure: (siteId: string, error: unknown) => void,
): Promise<ClaimedDeletionCleanupResult> => {
	let deletedSites = 0
	let deletedFiles = 0

	for (const site of sites) {
		try {
			const removed = await operations.removeStorage(site.siteId)
			const finalized = await operations.finalizeDeletion(site.siteId)
			deletedFiles += removed
			if (finalized) deletedSites += 1
		} catch (error) {
			reportFailure(site.siteId, error)
		}
	}

	return { sites: deletedSites, files: deletedFiles }
}
