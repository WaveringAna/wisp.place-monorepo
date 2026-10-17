/**
 * In-memory stand-in for the moderation API, used by dev.ts. It applies the same
 * view rules as the server (DESIGN.md) so the interface can be worked on without
 * postgres, the triage model or OAuth.
 */
import type {
	AccountView,
	ActiveLabel,
	LabelRequest,
	ModerationEvent,
	QueueResponse,
	QueueView,
	SiteSummary,
	Triage,
	VerdictRecord,
	VerdictRequest,
} from '../moderation/types'
import { VERDICTS } from '../moderation/types'
import { isDid } from './format'
import { inView } from './state'

type RawSite = Omit<SiteSummary, 'verdict' | 'labels'>

export const DEV_MODERATOR = { did: 'did:plc:okamimomdevmoderator', handle: 'okami.mom' }
/** Writes on this account's subjects always fail, to see the revert path. */
export const FAILING_HANDLE = 'broken.test'

const MINUTE = 60_000

type Seed = {
	handle: string
	rkey: string
	title: string
	excerpt: string
	outbound?: string[]
	files: number
	ageMinutes: number
	domain?: string
	triage?: Omit<Triage, 'model' | 'at'> | 'pending'
}

const SEEDS: Seed[] = [
	{
		handle: 'free-nitro-gifts.bsky.social',
		rkey: 'claim',
		title: 'Claim your free Discord Nitro',
		excerpt:
			'Limited offer! Log in with your Discord account to claim 3 months of Nitro for free. Hurry, only 200 codes left today. Enter your email and password below to verify you are human.',
		outbound: ['discord-gift-claim.ru', 'cdn.jsdelivr.net'],
		files: 3,
		ageMinutes: 12,
		triage: { flag: true, category: 'phishing', reason: 'Credential form imitating Discord login', confidence: 0.94 },
	},
	{
		handle: 'cryptoyield.bsky.social',
		rkey: 'home',
		title: 'Earn 12% daily on USDT',
		excerpt:
			'Guaranteed returns with our AI arbitrage bot. Deposit any amount, withdraw anytime. Join 40,000 investors earning passive income. Telegram support 24/7.',
		outbound: ['t.me', 'tronscan.org', 'yieldbot-pay.xyz'],
		files: 7,
		ageMinutes: 45,
		domain: 'cryptoyield.example',
		triage: { flag: true, category: 'scam', reason: 'Guaranteed high-yield investment promise', confidence: 0.88 },
	},
	{
		handle: 'seo-links-4u.bsky.social',
		rkey: 'casino-1',
		title: 'Best online casino bonus 2026',
		excerpt:
			'Top 10 online casinos with no deposit bonus. Best slots, best payout, best bonus. online casino bonus no deposit free spins casino casino casino.',
		outbound: ['casino-top10.biz', 'slots-free.biz', 'bonus-hunt.biz', 'track.affil.io'],
		files: 1,
		ageMinutes: 70,
		triage: {
			flag: true,
			category: 'seo-spam',
			reason: 'Keyword stuffing and affiliate casino links',
			confidence: 0.81,
		},
	},
	{
		handle: 'seo-links-4u.bsky.social',
		rkey: 'casino-2',
		title: 'Casino free spins no deposit',
		excerpt: 'free spins no deposit casino uk free spins no deposit casino usa free spins',
		outbound: ['casino-top10.biz', 'track.affil.io'],
		files: 1,
		ageMinutes: 71,
		triage: { flag: true, category: 'seo-spam', reason: 'Same template as casino-1', confidence: 0.79 },
	},
	{
		handle: 'seo-links-4u.bsky.social',
		rkey: 'casino-3',
		title: 'Casino bonus codes',
		excerpt: 'bonus codes casino bonus codes casino 2026 working codes',
		outbound: ['casino-top10.biz'],
		files: 1,
		ageMinutes: 72,
		triage: { flag: true, category: 'mass-created', reason: 'Near-identical to two sibling sites', confidence: 0.7 },
	},
	{
		handle: 'broken.test',
		rkey: 'site',
		title: 'Writes on this site fail (dev fixture)',
		excerpt: 'Any verdict or label on this site or its account answers 500, so the revert and error path can be seen.',
		files: 2,
		ageMinutes: 90,
		triage: { flag: true, category: 'test', reason: 'Fixture for the failure path', confidence: 0.5 },
	},
	{
		handle: 'm4ria.bsky.social',
		rkey: 'untitled',
		title: '',
		excerpt: '',
		files: 1,
		ageMinutes: 130,
		triage: { flag: true, category: 'empty', reason: 'No visible text, single index.html', confidence: 0.66 },
	},
	{
		handle: 'jonas.dev',
		rkey: 'blog',
		title: 'Jonas writes about compilers',
		excerpt:
			'Notes on register allocation, SSA construction and why my toy language finally has closures. This week: linear scan versus graph colouring on a real workload.',
		outbound: ['github.com', 'arxiv.org', 'en.wikipedia.org'],
		files: 48,
		ageMinutes: 20,
		domain: 'jonas.dev',
		triage: { flag: false, category: 'personal', reason: 'Technical blog', confidence: 0.96 },
	},
	{
		handle: 'ceramics-by-ines.bsky.social',
		rkey: 'shop',
		title: 'Ines Ceramics: handmade stoneware',
		excerpt:
			'Small-batch mugs, bowls and planters thrown by hand in Porto. Every piece is food safe and dishwasher friendly. Workshop dates for spring are up.',
		outbound: ['instagram.com', 'ko-fi.com'],
		files: 23,
		ageMinutes: 300,
		triage: { flag: false, category: 'shop', reason: 'Small business storefront', confidence: 0.92 },
	},
	{
		handle: 'lofi-club.bsky.social',
		rkey: 'radio',
		title: 'lofi club radio',
		excerpt: 'beats to moderate queues to. 24/7 stream, request a track in the chat.',
		outbound: ['youtube.com', 'soundcloud.com'],
		files: 6,
		ageMinutes: 2,
		triage: 'pending',
	},
	{
		handle: 'newbie-2931.bsky.social',
		rkey: 'test',
		title: 'test',
		excerpt: 'hello world',
		files: 1,
		ageMinutes: 1,
		triage: 'pending',
	},
	{
		handle: 'freegiftcards.bsky.social',
		rkey: 'amazon',
		title: 'Free $500 Amazon gift card',
		excerpt: 'Complete 3 offers and get a $500 Amazon gift card instantly. No credit card required.',
		outbound: ['offer-wall.click', 'bit.ly'],
		files: 2,
		ageMinutes: 2000,
		triage: { flag: true, category: 'scam', reason: 'Gift card offer wall', confidence: 0.9 },
	},
	{
		handle: 'freegiftcards.bsky.social',
		rkey: 'steam',
		title: 'Free Steam wallet codes',
		excerpt: 'Generate unlimited Steam wallet codes with our generator. 100% working 2026.',
		outbound: ['offer-wall.click'],
		files: 2,
		ageMinutes: 2010,
		triage: { flag: true, category: 'scam', reason: 'Fake code generator', confidence: 0.91 },
	},
	{
		handle: 'portfolio-sam.bsky.social',
		rkey: 'portfolio',
		title: 'Sam Okafor, product designer',
		excerpt: 'Selected work 2019–2026: design systems, onboarding flows and a very good settings page.',
		outbound: ['dribbble.com', 'linkedin.com'],
		files: 31,
		ageMinutes: 4000,
		domain: 'samokafor.design',
		triage: { flag: false, category: 'portfolio', reason: 'Personal portfolio', confidence: 0.97 },
	},
]

/** Filler so the recent view needs more than one page. */
function fillerSeeds(count: number): Seed[] {
	const topics = ['garden log', 'recipe box', 'zine archive', 'band page', 'wedding rsvp', 'hiking notes', 'pixel art']
	return Array.from({ length: count }, (_, i) => {
		const topic = topics[i % topics.length]!
		return {
			handle: `user${i + 1}.bsky.social`,
			rkey: topic.replace(' ', '-'),
			title: `${topic[0]!.toUpperCase()}${topic.slice(1)} #${i + 1}`,
			excerpt: `A small ${topic} published on wisp.place. Updated now and then.`,
			outbound: i % 3 === 0 ? ['github.com'] : [],
			files: 2 + (i % 9),
			ageMinutes: 500 + i * 97,
			triage: { flag: false, category: 'personal', reason: 'Ordinary personal site', confidence: 0.9 },
		}
	})
}

function didFor(handle: string): string {
	let hash = 0
	for (const char of handle) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
	return `did:plc:${hash.toString(36).padStart(8, 'x')}${handle.replace(/[^a-z0-9]/g, '').slice(0, 16)}`
}

export function createFixtureStore(now = Date.now()) {
	const iso = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE).toISOString()
	const sites = new Map<string, RawSite>()
	const verdicts = new Map<string, VerdictRecord>()
	let labels: ActiveLabel[] = []
	const events: ModerationEvent[] = []
	const handles = new Map<string, string>()

	function log(
		subject: string,
		kind: ModerationEvent['kind'],
		actor: string,
		data: Record<string, unknown>,
		at: string,
	) {
		const site = sites.get(subject)
		const handle = handles.get(site?.did ?? subject) ?? null
		events.push({
			id: events.length + 1,
			subject,
			kind,
			actor,
			data,
			at,
			handle,
			title: site ? site.title || null : null,
		})
	}

	for (const seed of [...SEEDS, ...fillerSeeds(30)]) {
		const did = didFor(seed.handle)
		handles.set(did, seed.handle)
		const uri = `at://${did}/place.wisp.fs/${seed.rkey}`
		const subdomain = `${seed.handle.split('.')[0]}.wisp.place`
		const domains = seed.domain ? [seed.domain, subdomain] : [subdomain]
		const triage: Triage | null =
			seed.triage === 'pending' || !seed.triage
				? null
				: { ...seed.triage, model: 'bonsai-8b', at: iso(seed.ageMinutes - 1) }
		sites.set(uri, {
			uri,
			did,
			rkey: seed.rkey,
			handle: seed.handle,
			url: `https://${domains[0]}/`,
			domains,
			title: seed.title,
			excerpt: seed.excerpt,
			outbound: seed.outbound ?? [],
			files: seed.files,
			firstSeen: iso(seed.ageMinutes + 5),
			updated: iso(seed.ageMinutes),
			deleted: false,
			state: triage ? (triage.flag ? 'flagged' : 'clear') : 'pending',
			triage,
		})
		log(uri, 'seen', 'system', {}, iso(seed.ageMinutes))
		if (triage) {
			const { flag, category, reason, confidence } = triage
			log(uri, 'triaged', 'model:bonsai-8b', { flag, category, reason, confidence }, triage.at)
		}
	}

	// One account taken down a while ago, and two earlier verdicts for the reviewed view.
	const giftDid = didFor('freegiftcards.bsky.social')
	labels.push({ uri: giftDid, val: '!takedown', cts: iso(1900) })
	log(giftDid, 'label', DEV_MODERATOR.did, { val: '!takedown', neg: false, note: 'gift card scam network' }, iso(1900))
	const reviewed: [string, VerdictRecord][] = [
		[
			`at://${didFor('portfolio-sam.bsky.social')}/place.wisp.fs/portfolio`,
			{ value: 'fine', note: '', by: DEV_MODERATOR.did, at: iso(3900), scope: 'site' },
		],
		[
			giftDid,
			{ value: 'spam', note: 'gift card scam network', by: DEV_MODERATOR.did, at: iso(1899), scope: 'account' },
		],
	]
	for (const [subject, record] of reviewed) {
		verdicts.set(subject, record)
		log(subject, 'verdict', record.by, { verdict: record.value, note: record.note }, record.at)
	}

	function summary(raw: RawSite): SiteSummary {
		const verdict = verdicts.get(raw.uri) ?? verdicts.get(raw.did) ?? null
		const state = verdict ? 'reviewed' : raw.state
		return {
			...raw,
			state,
			verdict,
			labels: labels.filter((label) => label.uri === raw.uri || label.uri === raw.did),
		}
	}

	function all(): SiteSummary[] {
		return [...sites.values()].map(summary).sort((a, b) => b.updated.localeCompare(a.updated))
	}

	function didOf(subject: string): string | null {
		if (isDid(subject)) return handles.has(subject) ? subject : null
		return sites.get(subject)?.did ?? null
	}

	function page<T>(items: T[], cursor: string | null, limit: number) {
		const start = cursor ? Number(cursor) : 0
		const end = start + limit
		return { items: items.slice(start, end), cursor: end < items.length ? String(end) : null }
	}

	return {
		failing(subject: string): boolean {
			const did = didOf(subject)
			return did !== null && handles.get(did) === FAILING_HANDLE
		},

		queue(view: QueueView, cursor: string | null, limit: number): QueueResponse {
			const everything = all()
			const counts = {} as Record<QueueView, number>
			for (const name of ['flagged', 'pending', 'recent', 'reviewed'] as const) {
				counts[name] = everything.filter((site) => inView(name, site)).length
			}
			const list = everything.filter((site) => inView(view, site))
			return { ...page(list, cursor, limit), counts }
		},

		account(did: string): AccountView | null {
			const handle = handles.get(did)
			if (!handle) return null
			return {
				did,
				handle,
				verdict: verdicts.get(did) ?? null,
				labels: labels.filter((label) => label.uri === did),
				sites: all().filter((site) => site.did === did),
				events: events
					.filter((event) => event.subject === did || event.subject.startsWith(`at://${did}/`))
					.slice(-20)
					.reverse(),
			}
		},

		search(q: string): { items: SiteSummary[] } {
			const needle = q.trim().toLowerCase()
			if (!needle) return { items: [] }
			const items = all().filter(
				(site) =>
					site.handle.includes(needle) ||
					site.did === needle ||
					site.title.toLowerCase().includes(needle) ||
					site.domains.some((domain) => domain.includes(needle)),
			)
			return { items: items.slice(0, 50) }
		},

		events(cursor: string | null, limit = 25) {
			return page([...events].reverse(), cursor, limit)
		},

		verdict(request: VerdictRequest, actor: string): { site: SiteSummary | null } | null {
			if (request.verdict !== null && !VERDICTS.includes(request.verdict)) return null
			if (didOf(request.uri) === null) return null
			const scope = isDid(request.uri) ? 'account' : 'site'
			if (request.verdict === null) verdicts.delete(request.uri)
			else {
				verdicts.set(request.uri, {
					value: request.verdict,
					note: request.note ?? '',
					by: actor,
					at: new Date().toISOString(),
					scope,
				})
			}
			log(
				request.uri,
				'verdict',
				actor,
				{ verdict: request.verdict, note: request.note ?? '' },
				new Date().toISOString(),
			)
			const raw = sites.get(request.uri)
			return { site: raw ? summary(raw) : null }
		},

		label(request: LabelRequest, actor: string): { labels: ActiveLabel[] } | null {
			if (didOf(request.uri) === null) return null
			labels = labels.filter((label) => !(label.uri === request.uri && label.val === request.val))
			if (!request.neg) labels.push({ uri: request.uri, val: request.val, cts: new Date().toISOString() })
			log(
				request.uri,
				'label',
				actor,
				{ val: request.val, neg: request.neg, note: request.note ?? '' },
				new Date().toISOString(),
			)
			return { labels: labels.filter((label) => label.uri === request.uri) }
		},
	}
}
