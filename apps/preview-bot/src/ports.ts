/**
 * The outside world the preview bot reads and writes, as plain functions. The verification and
 * comment logic depends only on this interface, so it is tested with in-memory fakes; the real
 * implementation is in ports-http.ts.
 *
 * Every value a port returns about a record or pipeline must come from the authority for it: a
 * record from the PDS of the DID in its AT-URI, a pipeline from the spindle named by the owner's
 * own repo record. The request that triggered the bot supplies none of it.
 */

/** A `sh.tangled.repo` record in a repo owner's PDS. */
export interface RepoRecord {
	rkey: string
	name?: string
	/** Hostname of the CI runner the owner configured for this repo. */
	spindle?: string
	/** The repo's own DID, when one was assigned. */
	repoDid?: string
}

/** A `sh.tangled.ci.pipeline` as reported by a spindle, reduced to what the bot needs. */
export interface Pipeline {
	/** DID of the repo the pipeline ran for. */
	repo?: string
	/** Set when the code was checked out from a different repo (a fork). */
	sourceRepo?: string
	/** The pull request trigger, absent for push, manual and schedule pipelines. */
	pullRequest?: {
		/** AT-URI of the `sh.tangled.repo.pull` record. */
		pull?: string
		/** Full 40-character head commit of the round that was built. */
		sourceSha: string
		/** Source branch name if pull URI was omitted by spindle. */
		sourceBranch?: string
	}
}

/** A `sh.tangled.repo.pull` record with the CID of the exact version read. */
export interface Pull {
	uri: string
	cid: string
	/** DID in the AT-URI: the pull request's author. */
	authorDid: string
	/** `target.repo`: DID of the repo the pull request is against. */
	targetRepoDid: string
	/** Number of submitted rounds; the newest round's index is one less. */
	roundCount: number
}

/** The bot's own comment on a pull request, if it already wrote one. */
export interface ExistingComment {
	rkey: string
	body: string
}

export interface CommentInput {
	pull: Pick<Pull, 'uri' | 'cid'>
	/** Index of the round the comment is about (`pullRoundIdx`). */
	roundIdx: number
	body: string
}

export interface Ports {
	/** The owner's `sh.tangled.repo` records, read from the owner's PDS. */
	listRepoRecords(ownerDid: string): Promise<RepoRecord[]>
	/** `sh.tangled.ci.getPipeline` on the given spindle host; null when it has no such pipeline. */
	getPipeline(spindleHost: string, pipelineId: string): Promise<Pipeline | null>
	/** Find the newest pull-request pipeline whose source commit starts with sha7. */
	findPipelineForCommit(spindleHost: string, repoDid: string, sha7: string): Promise<string | null>
	/** The pull record from its author's PDS; null when it does not exist. */
	getPull(uri: string): Promise<Pull | null>
	/** The open pull from `sourceBranch` into the repo, by any author, for spindles that leave the pull URI out. */
	findPullForBranch(targetRepoDid: string, sourceBranch: string): Promise<Pull | null>
	/** DID that claimed the wisp subdomain `<claim>.<base host>`, or null when unclaimed. */
	claimOwner(claim: string): Promise<string | null>
	/** Whether the preview URL answers 200 right now. */
	previewServes(url: string): Promise<boolean>
	findComment(pullUri: string): Promise<ExistingComment | null>
	createComment(input: CommentInput): Promise<void>
	updateComment(rkey: string, input: CommentInput): Promise<void>
}
