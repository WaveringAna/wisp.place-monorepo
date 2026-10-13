import { db } from './db'
import { createPrivateSitesRepository } from './private-sites-repository'

export {
	type CreatePrivateSiteInput,
	type CreateShareResult,
	type PrivateSiteDeletionClaim,
	PrivateSiteUnavailableError,
	type StagedPrivateSite,
} from './private-sites-repository'

/** The private site metadata repository on the primary database. */
export const {
	createPrivateSite,
	renewPrivateSiteStagingLease,
	markPrivateSiteReady,
	abandonStagedPrivateSite,
	getPrivateSite,
	getLivePrivateSite,
	hasLivePrivateSite,
	listPrivateSitesByOwner,
	claimPrivateSiteDeletionForOwner,
	finalizePrivateSiteDeletion,
	deletePrivateSite,
	claimPrivateSitesForReaping,
	listExpiredPrivateSites,
	listShares,
	findSharesByTokenHash,
	findLiveShareForAudience,
	findSiteIdByShareTokenHash,
	createShare,
	revokeShare,
	touchShare,
	createOwnerHandoff,
	createShareHandoff,
	pruneHandoffs,
	pruneSessions,
} = createPrivateSitesRepository(db)
