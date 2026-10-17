/**
 * The moderation API's wire types, shared by the server (src/moderation) and the
 * interface (src/ui). See apps/labeler/DESIGN.md.
 */

export type Verdict = 'fine' | 'empty' | 'mass-created' | 'spam'
export const VERDICTS: readonly Verdict[] = ['fine', 'empty', 'mass-created', 'spam']

/** Labels a moderator can apply from the interface. */
export type ModerationAction = '!takedown' | '!hide'
export const MODERATION_ACTIONS: readonly ModerationAction[] = ['!takedown', '!hide']

/**
 * pending: seen, not yet triaged. clear: the model saw nothing. flagged: the model
 * flagged it. reviewed: a moderator gave the site or its account a verdict.
 */
export type SubjectState = 'pending' | 'clear' | 'flagged' | 'reviewed'

export type Triage = {
	flag: boolean
	category: string
	reason: string
	confidence: number
	model: string
	at: string
}

export type ActiveLabel = { uri: string; val: string; cts: string }

export type VerdictRecord = {
	value: Verdict
	note: string
	by: string
	at: string
	/** A verdict on the account covers every site of it. */
	scope: 'site' | 'account'
}

export type SiteSummary = {
	/** The site's record: at://<did>/place.wisp.fs/<rkey>. */
	uri: string
	did: string
	rkey: string
	handle: string
	/** Where it is served: a verified custom domain, a wisp subdomain, or sites.wisp.place/<handle>/<rkey>/. */
	url: string
	domains: string[]
	title: string
	/** The first few hundred characters of visible text. */
	excerpt: string
	/** Hosts the page links to. */
	outbound: string[]
	files: number
	firstSeen: string
	/** When this version of the site was published. */
	updated: string
	deleted: boolean
	state: SubjectState
	verdict: VerdictRecord | null
	triage: Triage | null
	/** Active labels on the site or on its account. */
	labels: ActiveLabel[]
}

export type QueueView = 'flagged' | 'pending' | 'recent' | 'reviewed'

export type QueueResponse = {
	items: SiteSummary[]
	cursor: string | null
	counts: Record<QueueView, number>
}

export type ModerationEvent = {
	id: number
	/** A site URI or an account DID. */
	subject: string
	kind: 'seen' | 'triaged' | 'verdict' | 'label'
	/** A moderator DID, `model:<name>` or `system`. */
	actor: string
	/**
	 * triaged: Triage. verdict: { verdict: Verdict | null, note }.
	 * label: { val, neg, note, seq }. seen: { recordCid, updated }.
	 */
	data: Record<string, unknown>
	at: string
	/** The subject's handle and, for a site, its title, when known. */
	handle: string | null
	title: string | null
}

export type AccountView = {
	did: string
	handle: string
	verdict: VerdictRecord | null
	labels: ActiveLabel[]
	sites: SiteSummary[]
	events: ModerationEvent[]
}

export type Me = { did: string; handle: string }

export type VerdictRequest = { uri: string; verdict: Verdict | null; note?: string }
export type LabelRequest = { uri: string; val: ModerationAction; neg: boolean; note?: string }
export type ApiError = { error: string }
