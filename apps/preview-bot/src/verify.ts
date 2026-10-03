import type { Ports } from './ports'

/** What the workflow sends: only identifiers, never facts. Everything else is looked up. */
export interface PreviewRequest {
	/** DID of the repo owner (`TANGLED_REPO_DID`). */
	owner: string
	/** Name of the repo (`TANGLED_REPO_NAME`). */
	repo: string
	/** Spindle pipeline id: the last segment of `TANGLED_PIPELINE_ID`. */
	pipeline: string
	/** Wisp subdomain the preview was deployed under. */
	claim: string
}

export type Rejection =
	| 'bad-request'
	| 'repo-not-found'
	| 'repo-ambiguous'
	| 'repo-unusable'
	| 'pipeline-not-found'
	| 'not-a-pull-request'
	| 'fork-pull-request'
	| 'repo-mismatch'
	| 'pull-not-found'
	| 'pull-repo-mismatch'
	| 'pull-has-no-rounds'
	| 'claim-not-owned'
	| 'label-too-long'
	| 'preview-not-serving'

export type Verification =
	| {
			ok: true
			url: string
			sha7: string
			pull: { uri: string; cid: string }
			roundIdx: number
	  }
	| { ok: false; reason: Rejection }

const DID = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]{1,253})$/
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/
const PIPELINE_ID = /^[a-z0-9]{1,64}$/
const CLAIM = /^[a-z0-9]+(-[a-z0-9]+)*$/
const HEX40 = /^[0-9a-f]{40}$/
const MAX_LABEL_LENGTH = 63

const reject = (reason: Rejection): Verification => ({ ok: false, reason })

export function isWellFormed(request: PreviewRequest): boolean {
	return (
		DID.test(request.owner) &&
		REPO_NAME.test(request.repo) &&
		PIPELINE_ID.test(request.pipeline) &&
		CLAIM.test(request.claim)
	)
}

/**
 * Decide whether the bot may comment a preview link on a pull request. Each fact is read from
 * the authority that owns it and has to agree with the next one:
 *
 *   owner's repo record (owner's PDS)  ->  names the spindle and the repo's DID
 *   pipeline (that spindle)            ->  same repo, a pull request run, names the pull
 *   pull record (author's PDS)         ->  targets that same repo
 *   wisp subdomain claim (our db)      ->  owned by the repo's owner
 *
 * The last link is what stops someone from naming a site `pr-<sha7>` under their own claim and
 * having the bot advertise it on a repo that is not theirs.
 */
export async function verifyPreview(
	request: PreviewRequest,
	ports: Ports,
	config: { previewHost: string },
): Promise<Verification> {
	if (!isWellFormed(request)) return reject('bad-request')

	const named = (await ports.listRepoRecords(request.owner)).filter((record) => record.name === request.repo)
	if (named.length === 0) return reject('repo-not-found')
	const [record] = named
	if (!record || new Set(named.map((candidate) => candidate.repoDid)).size > 1) return reject('repo-ambiguous')
	if (!record.spindle || !record.repoDid) return reject('repo-unusable')

	const pipeline = await ports.getPipeline(record.spindle, request.pipeline)
	if (!pipeline) return reject('pipeline-not-found')
	const trigger = pipeline.pullRequest
	if (!trigger || !HEX40.test(trigger.sourceSha) || (!trigger.pull && !trigger.sourceBranch))
		return reject('not-a-pull-request')
	if (pipeline.sourceRepo && pipeline.sourceRepo !== pipeline.repo) return reject('fork-pull-request')
	if (pipeline.repo !== record.repoDid) return reject('repo-mismatch')

	const pull = trigger.pull
		? await ports.getPull(trigger.pull)
		: trigger.sourceBranch && ports.findPullForBranch
			? await ports.findPullForBranch(request.owner, record.repoDid, trigger.sourceBranch)
			: null
	if (!pull) return reject('pull-not-found')
	if (pull.targetRepoDid !== record.repoDid) return reject('pull-repo-mismatch')
	if (pull.roundCount < 1) return reject('pull-has-no-rounds')

	if ((await ports.claimOwner(request.claim)) !== request.owner) return reject('claim-not-owned')

	const sha7 = trigger.sourceSha.slice(0, 7)
	const label = `pr-${sha7}-${request.claim}`
	if (label.length > MAX_LABEL_LENGTH) return reject('label-too-long')
	const url = `https://${label}.${config.previewHost}/`
	if (!(await ports.previewServes(url))) return reject('preview-not-serving')

	return { ok: true, url, sha7, pull: { uri: pull.uri, cid: pull.cid }, roundIdx: pull.roundCount - 1 }
}
