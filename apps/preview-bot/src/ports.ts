/**
 * The outside world the preview bot reads and writes, as plain functions. The verification and
 * comment logic depends only on this interface, so it is tested with in-memory fakes; the real
 * implementation is in ports-http.ts.
 *
 * Every value a port returns about a record or pipeline must come from the authority for it: a
 * record from the PDS of the DID in its AT-URI, a pipeline from the spindle named by the repo's
 * own manifest (or, before Tangled 1.0, the owner's repo record). The request that triggered the
 * bot supplies none of it.
 *
 * Tangled 1.0 keeps pull requests, rounds and comments in the repo DID's account on its knot
 * (`org.tangled.*`); older repos keep them in their authors' PDSes (`sh.tangled.*`). The ports
 * read whichever a repo or record has.
 */

/** A repo the owner claims in their PDS: a `sh.tangled.repo` record or an `org.tangled.repo.declaration`. */
export interface RepoRecord {
	rkey: string
	name?: string
	/** Hostname of the CI runner the owner configured for this repo. */
	spindle?: string
	/** The repo's own DID, when one was assigned. */
	repoDid?: string
}

/** A spindle pipeline (`org.tangled.ci.defs#pipeline`, or `sh.tangled.ci` before 1.0), reduced to what the bot needs. */
export interface Pipeline {
	/** DID of the repo the pipeline ran for. */
	repo?: string
	/** Set when the code was checked out from a different repo (a fork). */
	sourceRepo?: string
	/** The pull request trigger, absent for push, manual and schedule pipelines. */
	pullRequest?: {
		/** AT-URI of the pull: an `org.tangled.track.ticket`, or a `sh.tangled.repo.pull` before 1.0. */
		pull?: string
		/** Full 40-character head commit of the round that was built. */
		sourceSha: string
		/** Source branch name if pull URI was omitted by spindle. */
		sourceBranch?: string
	}
}

/** A pull request (1.0 ticket or older pull record) with the CID of the exact version read. */
export interface Pull {
	uri: string
	cid: string
	/** The AT-URI's DID before 1.0; on a 1.0 ticket, its `x-tngl-editor`, the account that last wrote it. */
	authorDid: string
	/** DID of the repo the pull request is against: `target.repo`, or a 1.0 ticket's own repo account. */
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

/** A Tangled 1.0 `org.tangled.repo.manifest/self`, read from the repo's own knot. */
export interface RepoManifest {
	/** `declaration.owner` and `declaration.name`: the owner's half of the claim has to agree. */
	owner: string
	name: string
	/** Hostname of the spindle the manifest names, resolved from its did:web. */
	spindle?: string
}

export interface Ports {
	/** The repos the owner claims, read from the owner's PDS. */
	listRepoRecords(ownerDid: string): Promise<RepoRecord[]>
	/** The repo's 1.0 manifest from its knot; null for a repo whose knot predates 1.0. */
	repoManifest(repoDid: string): Promise<RepoManifest | null>
	/** `getPipeline` on the given spindle host; null when it has no such pipeline. */
	getPipeline(spindleHost: string, repoDid: string, pipelineId: string): Promise<Pipeline | null>
	/** Find the newest pull-request pipeline whose source commit starts with sha7. */
	findPipelineForCommit(spindleHost: string, repoDid: string, sha7: string): Promise<string | null>
	/** The pull from its authority (repo's knot for a 1.0 ticket, author's PDS before); null when absent. */
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
