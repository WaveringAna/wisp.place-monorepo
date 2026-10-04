import type { Ports, RepoRecord } from './ports'

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
	| 'not-a-collaborator'
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
const SHA7 = /^[0-9a-f]{7}$/
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
 *   wisp subdomain claim (our db)      ->  owned by the repo's owner or a collaborator on it
 *
 * The last link is what stops someone from naming a site `pr-<sha7>` under their own claim and
 * having the bot advertise it on a repo they do not work on.
 */
export async function verifyPreview(
	request: PreviewRequest,
	ports: Ports,
	config: { previewHost: string },
): Promise<Verification> {
	if (!isWellFormed(request)) return reject('bad-request')
	const record = await findRepo(ports, request.owner, request.repo)
	if (typeof record === 'string') return reject(record)
	return verifyFromPipeline(request, record, request.pipeline, ports, config)
}

/** What a webhook delivery for a `place.wisp.fs/pr-<sha7>` write names: the commit, not the pipeline. */
export interface HookRequest {
	/** DID of the repo owner; the deployer themselves unless the hook names someone else. */
	owner: string
	/** DID whose site record fired the hook: the preview lives in their repo, under their claim. */
	deployer: string
	repo: string
	claim: string
	sha7: string
}

export const isHookWellFormed = (request: HookRequest): boolean =>
	DID.test(request.owner) &&
	DID.test(request.deployer) &&
	REPO_NAME.test(request.repo) &&
	CLAIM.test(request.claim) &&
	SHA7.test(request.sha7)

/** Same chain as {@link verifyPreview}, starting from the spindle's newest pull-request run of that commit. */
export async function verifyHook(
	request: HookRequest,
	ports: Ports,
	config: { previewHost: string },
): Promise<Verification> {
	if (!isHookWellFormed(request)) return reject('bad-request')
	const record = await findRepo(ports, request.owner, request.repo)
	if (typeof record === 'string') return reject(record)
	const pipeline = await ports.findPipelineForCommit(record.spindle, record.repoDid, request.sha7)
	if (!pipeline) return reject('pipeline-not-found')
	return verifyFromPipeline(request, record, pipeline, ports, config)
}

type UsableRepo = RepoRecord & { spindle: string; repoDid: string }

async function findRepo(ports: Ports, owner: string, repo: string): Promise<UsableRepo | Rejection> {
	const named = (await ports.listRepoRecords(owner)).filter((record) => record.name === repo)
	if (named.length === 0) return 'repo-not-found'
	const [record] = named
	if (!record || new Set(named.map((candidate) => candidate.repoDid)).size > 1) return 'repo-ambiguous'
	if (!record.spindle || !record.repoDid) return 'repo-unusable'
	return { ...record, spindle: record.spindle, repoDid: record.repoDid }
}

async function verifyFromPipeline(
	request: { owner: string; claim: string; deployer?: string },
	record: UsableRepo,
	pipelineId: string,
	ports: Ports,
	config: { previewHost: string },
): Promise<Verification> {
	const pipeline = await ports.getPipeline(record.spindle, pipelineId)
	if (!pipeline) return reject('pipeline-not-found')
	const trigger = pipeline.pullRequest
	if (!trigger || !HEX40.test(trigger.sourceSha) || (!trigger.pull && !trigger.sourceBranch))
		return reject('not-a-pull-request')
	if (pipeline.sourceRepo && pipeline.sourceRepo !== pipeline.repo) return reject('fork-pull-request')
	if (pipeline.repo !== record.repoDid) return reject('repo-mismatch')

	const pull = trigger.pull
		? await ports.getPull(trigger.pull)
		: trigger.sourceBranch
			? await ports.findPullForBranch(record.repoDid, trigger.sourceBranch)
			: null
	if (!pull) return reject('pull-not-found')
	if (pull.targetRepoDid !== record.repoDid) return reject('pull-repo-mismatch')
	if (pull.roundCount < 1) return reject('pull-has-no-rounds')

	const claimant = await ports.claimOwner(request.claim)
	if (!claimant || (request.deployer && claimant !== request.deployer)) return reject('claim-not-owned')
	if (claimant !== request.owner && !(await ports.isCollaborator(record.repoDid, claimant)))
		return reject('not-a-collaborator')

	const sha7 = trigger.sourceSha.slice(0, 7)
	const label = `pr-${sha7}-${request.claim}`
	if (label.length > MAX_LABEL_LENGTH) return reject('label-too-long')
	const url = `https://${label}.${config.previewHost}/`
	if (!(await ports.previewServes(url))) return reject('preview-not-serving')

	return { ok: true, url, sha7, pull: { uri: pull.uri, cid: pull.cid }, roundIdx: pull.roundCount - 1 }
}
