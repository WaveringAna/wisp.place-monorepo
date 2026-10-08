import { describe, expect, test } from 'bun:test'
import {
	backoffDelaySec,
	checkStatus,
	DEFAULT_DNS_VERIFICATION_POLICY,
	type DomainVerificationColumns,
	type DomainVerificationState,
	resolveDnsVerificationPolicy,
} from './dns-verification-schedule'
import { DNSVerificationWorker, type DnsVerificationStore, type PassOutcome } from './dns-verification-worker'
import type { VerificationResult } from './dns-verify'

const policy = DEFAULT_DNS_VERIFICATION_POLICY
const PASS = policy.passIntervalSec
const T0 = 1_800_000_000

interface FakeDatabase {
	now: number
	lastPassAt: number | null
	locked: boolean
	rows: Map<string, DomainVerificationState>
	writes: Array<{ id: string; columns: DomainVerificationColumns }>
}

const newDomain = (id: string, verified: boolean): DomainVerificationState => ({
	id,
	domain: `${id}.example.test`,
	did: `did:plc:${id}`,
	verified,
	lastVerifiedAt: null,
	failures: 0,
	failingSince: null,
	lost: false,
	nextCheckAt: null,
	parkedAt: null,
	warning: null,
})

const fakeDatabase = (domains: DomainVerificationState[]): FakeDatabase => ({
	now: T0,
	lastPassAt: null,
	locked: false,
	rows: new Map(domains.map((domain) => [domain.id, domain])),
	writes: [],
})

/** Same contract as the Postgres store: one advisory lock shared by every worker. */
const fakeStore = (database: FakeDatabase): DnsVerificationStore => ({
	async withPassLock(pass) {
		if (database.locked) return { acquired: false }
		database.locked = true
		try {
			return { acquired: true, value: await pass() }
		} finally {
			database.locked = false
		}
	},
	async readPassClock() {
		return { lastPassAt: database.lastPassAt, now: database.now }
	},
	async recordPass(startedAt) {
		database.lastPassAt = startedAt
	},
	async removeDuplicateRows() {
		return 0
	},
	async listDomains() {
		return [...database.rows.values()].map((row) => ({ ...row }))
	},
	async currentOwnerId(domain) {
		return [...database.rows.values()].find((row) => row.domain === domain)?.id ?? null
	},
	async saveDomain(id, did, columns) {
		const row = database.rows.get(id)
		if (!row || row.did !== did) return false
		database.rows.set(id, { ...row, ...columns })
		database.writes.push({ id, columns })
		return true
	},
})

type DnsAnswer = (id: string) => VerificationResult

const harness = (domains: DomainVerificationState[], answer: DnsAnswer) => {
	const database = fakeDatabase(domains)
	const checks: Array<{ id: string; at: number }> = []
	const logs: Array<{ message: string; data?: Record<string, unknown> }> = []
	const sleeps: number[] = []
	const worker = () =>
		new DNSVerificationWorker({
			store: fakeStore(database),
			policy,
			verify: async (_domain, did) => {
				const id = did.slice('did:plc:'.length)
				checks.push({ id, at: database.now })
				return answer(id)
			},
			onLog: (message, data) => logs.push({ message, data }),
			sleep: async (ms) => {
				sleeps.push(ms)
			},
		})
	return { database, checks, logs, sleeps, worker }
}

const verified: DnsAnswer = () => ({ verified: true, found: { txt: ['did'] } })
const missing: DnsAnswer = () => ({ verified: false, error: 'TXT record mismatch', found: { txt: [] } })
const noNameservers: DnsAnswer = (id) => ({
	verified: false,
	error: `DNS lookup failed: No NS records found for _wisp.${id}.example.test`,
	found: { txt: [] },
})

/** Two instances ticking every interval, the second half an interval later. */
const runTwoInstances = async (
	h: ReturnType<typeof harness>,
	durationSec: number,
	onTick?: () => void,
): Promise<PassOutcome[]> => {
	const [a, b] = [h.worker(), h.worker()]
	const outcomes: PassOutcome[] = []
	for (let elapsed = 0; elapsed < durationSec; elapsed += PASS) {
		onTick?.()
		outcomes.push(await a.runPass(false))
		h.database.now += PASS / 2
		outcomes.push(await b.runPass(false))
		h.database.now += PASS / 2
	}
	return outcomes
}

const summaries = (logs: Array<{ message: string; data?: Record<string, unknown> }>) =>
	logs.filter((log) => log.message === 'DNS verification check completed')

describe('DNS verification worker', () => {
	test('two instances run one pass between them while one holds the lock', async () => {
		let release: () => void = () => undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const domains = Array.from({ length: 5 }, (_, i) => newDomain(`d${i}`, true))
		const h = harness(domains, verified)
		const slow = new DNSVerificationWorker({
			store: fakeStore(h.database),
			policy,
			verify: async (_domain, did) => {
				await gate
				h.checks.push({ id: did, at: h.database.now })
				return verified(did)
			},
		})

		const first = slow.runPass(false)
		const second = await h.worker().runPass(false)
		release()

		expect(second).toBe('locked')
		expect(await first).toBe('completed')
		expect(h.checks).toHaveLength(5)
	})

	test('a second instance skips a pass that already ran this interval', async () => {
		const h = harness([newDomain('a', false), newDomain('b', true)], missing)
		const outcomes = await runTwoInstances(h, 6 * PASS)

		expect(outcomes.filter((outcome) => outcome === 'completed')).toHaveLength(6)
		expect(outcomes.filter((outcome) => outcome === 'recent')).toHaveLength(6)
		expect(summaries(h.logs)).toHaveLength(6)
	})

	test('failing domains back off 10 min, 30 min, 1 h, 6 h, then daily', async () => {
		const h = harness([newDomain('pending', false)], missing)
		await runTwoInstances(h, 4 * 86400)

		const times = h.checks.map((check) => check.at)
		const gaps = times.slice(1).map((at, i) => at - (times[i] as number))
		expect(gaps).toEqual([600, 1800, 3600, 21600, 86400, 86400, 86400])
		// Pending domains have no grace and are not rechecked within a pass.
		expect(h.sleeps).toHaveLength(0)
	})

	test('a verified domain whose DNS is removed keeps serving for the grace window, then retries at least hourly', async () => {
		let dnsPresent = true
		const h = harness([newDomain('site', true)], () => (dnsPresent ? verified('site') : missing('site')))
		const worker = h.worker()
		await worker.runPass(false)
		dnsPresent = false
		const removedAt = h.database.now
		for (let at = h.database.now + PASS; at <= removedAt + 8 * 3600; at += PASS) {
			h.database.now = at
			await worker.runPass(false)
		}

		const passes = [...new Set(h.checks.slice(1).map((check) => check.at))]
		const gaps = passes.slice(1).map((at, i) => at - (passes[i] as number))
		// Three more passes in grace, then 10 min, then hourly.
		expect(gaps.slice(0, 5)).toEqual([600, 600, 600, 600, 3600])
		expect(Math.max(...gaps)).toBe(3600)
		const unverified = h.database.writes.filter((write) => !write.columns.verified)
		const firstFailure = passes[0] as number
		expect(unverified[0]?.columns.lastVerifiedAt).toBe(firstFailure + policy.unverifyAfterSec)
		expect(
			h.logs.filter((log) => log.message === 'Verified domain failing DNS verification, still serving'),
		).toHaveLength(1)
		expect(h.logs.filter((log) => log.message === 'Previously verified domain failed DNS verification')).toHaveLength(1)
		expect(h.database.rows.get('site')?.verified).toBe(false)
	})

	test('a lookup blip in one pass never writes verified=false', async () => {
		let failing = false
		const h = harness([newDomain('blip', true)], () => (failing ? noNameservers('blip') : verified('blip')))
		const worker = h.worker()
		await worker.runPass(false)

		// Every lookup of one whole pass fails, the in-pass rechecks included.
		failing = true
		h.database.now += policy.verifiedRecheckSec
		await worker.runPass(false)
		expect(h.database.rows.get('blip')).toMatchObject({ verified: true, failures: 1 })
		failing = false
		h.database.now += PASS
		await worker.runPass(false)

		expect(h.database.writes.every((write) => write.columns.verified)).toBe(true)
		expect(h.database.rows.get('blip')).toMatchObject({ verified: true, failures: 0, failingSince: null, lost: false })
		expect(
			h.logs.filter((log) => log.message === 'Verified domain failing DNS verification, still serving'),
		).toHaveLength(1)
		expect(h.logs.filter((log) => log.message === 'Verified domain recovered within its grace window')).toHaveLength(1)
	})

	test('a verified domain that recovers inside the grace window is never unverified', async () => {
		let failingPasses = 0
		const h = harness([newDomain('flaky', true)], () => (failingPasses > 0 ? missing('flaky') : verified('flaky')))
		const worker = h.worker()
		await worker.runPass(false)
		h.database.now += policy.verifiedRecheckSec
		for (failingPasses = 3; failingPasses > 0; failingPasses--) {
			await worker.runPass(false)
			h.database.now += PASS
		}
		await worker.runPass(false)
		// Back to the hourly schedule without another write.
		const writes = h.database.writes.length
		h.database.now += PASS
		await worker.runPass(false)

		expect(h.database.writes.every((write) => write.columns.verified)).toBe(true)
		expect(h.database.writes.length).toBe(writes)
		expect(h.database.rows.get('flaky')).toMatchObject({ verified: true, failures: 0, failingSince: null })
		expect(h.logs.filter((log) => log.message === 'Previously verified domain failed DNS verification')).toHaveLength(0)
	})

	test('rechecks a failing verified domain within the pass and keeps it when a recheck passes', async () => {
		let calls = 0
		const h = harness([newDomain('transient', true)], () =>
			++calls === 2 ? missing('transient') : verified('transient'),
		)
		const worker = h.worker()
		await worker.runPass(false)
		h.database.writes.length = 0
		h.database.now += policy.verifiedRecheckSec
		await worker.runPass(false)

		expect(calls).toBe(3)
		expect(h.sleeps).toEqual([policy.confirmDelaySec * 1000])
		expect(h.database.writes).toHaveLength(0)
		expect(h.database.rows.get('transient')).toMatchObject({ verified: true, failures: 0, failingSince: null })
		const passes = summaries(h.logs)
		expect(passes[passes.length - 1]?.data).toMatchObject({ confirmRetries: 1, confirmRescued: 1, failed: 0 })
	})

	test('rechecks at most confirmMaxDomains failing domains in one pass', async () => {
		const domains = Array.from({ length: policy.confirmMaxDomains + 5 }, (_, i) => newDomain(`many${i}`, true))
		let failing = false
		const h = harness(domains, (id) => (failing ? noNameservers(id) : verified(id)))
		const worker = h.worker()
		await worker.runPass(false)
		failing = true
		const checksBefore = h.checks.length
		h.database.now += policy.verifiedRecheckSec
		await worker.runPass(false)

		const retries = policy.confirmMaxDomains * policy.confirmRetries
		expect(h.checks.length - checksBefore).toBe(domains.length + retries)
		expect([...h.database.rows.values()].every((row) => row.verified && row.failures === 1)).toBe(true)
		const passes = summaries(h.logs)
		expect(passes[passes.length - 1]?.data).toMatchObject({ confirmRetries: retries, confirmSkipped: 5 })
	})

	test('unverifies at once when the TXT record names another DID', async () => {
		let moved = false
		const h = harness([newDomain('sold', true)], () =>
			moved
				? { verified: false, error: 'TXT record does not match', found: { txt: ['did:plc:new-owner'] } }
				: verified('sold'),
		)
		const worker = h.worker()
		await worker.runPass(false)
		moved = true
		h.database.now += policy.verifiedRecheckSec
		await worker.runPass(false)

		expect(h.sleeps).toHaveLength(0)
		expect(h.database.rows.get('sold')).toMatchObject({ verified: false, lost: true, failures: 1 })
		const lost = h.logs.find((log) => log.message === 'Previously verified domain failed DNS verification')
		expect(lost?.data).toMatchObject({ otherOwner: true })
	})

	test('parks a domain after seven days of failure and logs it once', async () => {
		const h = harness([newDomain('stale', false)], missing)
		await runTwoInstances(h, 10 * 86400)

		const row = h.database.rows.get('stale')
		expect(row?.parkedAt).not.toBeNull()
		const lastCheck = h.checks[h.checks.length - 1]?.at as number
		expect(lastCheck - T0).toBeGreaterThanOrEqual(policy.parkAfterSec)
		expect(lastCheck - T0).toBeLessThan(policy.parkAfterSec + 86400 + PASS)
		expect(h.logs.filter((log) => log.message.startsWith('Domain verification parked'))).toHaveLength(1)
		const passes = summaries(h.logs)
		expect(passes[passes.length - 1]?.data).toMatchObject({ parked: 1, totalChecked: 0 })
	})

	test('a parked domain is checked again on the next pass once its owner resets it', async () => {
		let dnsPresent = false
		const h = harness([newDomain('late', false)], () => (dnsPresent ? verified('late') : missing('late')))
		await runTwoInstances(h, 8 * 86400)
		const parked = h.database.rows.get('late') as DomainVerificationState
		expect(parked.parkedAt).not.toBeNull()

		// What updateCustomDomainVerification writes after a failed user check.
		dnsPresent = true
		h.database.rows.set('late', { ...parked, failures: 0, failingSince: null, nextCheckAt: null, parkedAt: null })
		const checksBefore = h.checks.length
		await runTwoInstances(h, PASS)

		expect(h.checks.length).toBe(checksBefore + 1)
		expect(h.database.rows.get('late')).toMatchObject({ verified: true, parkedAt: null, failures: 0 })
		expect(h.logs.filter((log) => log.message === 'Domain verified')).toHaveLength(1)
	})

	test('checks each verified domain once an hour and writes nothing while its DNS is unchanged', async () => {
		const domains = Array.from({ length: 60 }, (_, i) => newDomain(`v${i}`, true))
		const h = harness(domains, verified)
		await runTwoInstances(h, PASS)
		// The first pass refreshes every last_verified_at once.
		expect(h.database.writes).toHaveLength(60)
		h.database.writes.length = 0
		const checksBefore = h.checks.length

		await runTwoInstances(h, 3600)

		expect(h.checks.length - checksBefore).toBe(60)
		expect(new Set(h.checks.slice(checksBefore).map((check) => check.id)).size).toBe(60)
		expect(h.database.writes).toHaveLength(0)
	})

	test('refreshes last_verified_at of an unchanged verified domain at most every six hours', async () => {
		const h = harness([newDomain('steady', true)], verified)
		await runTwoInstances(h, 24 * 3600)

		const refreshes = h.database.writes.map((write) => write.columns.lastVerifiedAt as number)
		const gaps = refreshes.slice(1).map((at, i) => at - (refreshes[i] as number))
		expect(refreshes.length).toBeGreaterThanOrEqual(4)
		for (const gap of gaps) {
			expect(gap).toBeGreaterThanOrEqual(policy.lastCheckedRefreshSec)
			expect(gap).toBeLessThanOrEqual(policy.lastCheckedRefreshSec + policy.verifiedRecheckSec)
		}
	})

	test('logs a DNS warning once across passes and instances, and again when it changes', async () => {
		let warning = 'Multiple TXT records found at _wisp.nekomimi.pet'
		const h = harness([newDomain('nekomimi', true)], () => ({ verified: true, warning, found: { txt: ['a', 'b'] } }))
		await runTwoInstances(h, 6 * 3600)
		warning = 'Multiple TXT records found at _wisp.nekomimi.pet: did:plc:other'
		await runTwoInstances(h, 6 * 3600)

		const warnings = h.logs.filter((log) => log.message === 'DNS verification warning')
		expect(warnings.map((log) => log.data?.warning)).toEqual([
			'Multiple TXT records found at _wisp.nekomimi.pet',
			'Multiple TXT records found at _wisp.nekomimi.pet: did:plc:other',
		])
		expect(h.database.rows.get('nekomimi')?.warning).toBe(warning)
	})

	test('does not write when ownership changed while DNS was checked', async () => {
		const h = harness([newDomain('race', false)], verified)
		const store = fakeStore(h.database)
		const worker = new DNSVerificationWorker({
			store: { ...store, currentOwnerId: async () => 'someone-else' },
			policy,
			verify: async () => verified('race'),
		})

		expect(await worker.runPass(false)).toBe('completed')
		expect(h.database.writes).toHaveLength(0)
		expect(h.database.rows.get('race')?.verified).toBe(false)
	})

	test('a failed pass does not record the window, so the next pass covers it', async () => {
		const h = harness([newDomain('v', true)], verified)
		const store = fakeStore(h.database)
		const worker = new DNSVerificationWorker({
			store: {
				...store,
				listDomains: async () => {
					throw new Error('connection reset')
				},
			},
			policy,
			verify: async () => verified('v'),
		})

		expect(await worker.runPass(false)).toBe('failed')
		expect(h.database.lastPassAt).toBeNull()
		expect(worker.getHealth().stats.passesRun).toBe(1)
	})
})

describe('DNS verification schedule', () => {
	test('spreads verified rechecks across the passes of an hour', () => {
		const domains = Array.from({ length: 600 }, (_, i) => newDomain(`id-${i}`, true))
		const perPass = Array.from({ length: 6 }, (_, pass) => {
			const window = { from: T0 + pass * PASS, to: T0 + (pass + 1) * PASS }
			return domains.filter((domain) => checkStatus(domain, window, policy) === 'due').length
		})

		expect(perPass.reduce((sum, count) => sum + count, 0)).toBe(600)
		for (const count of perPass) expect(count).toBeGreaterThan(50)
	})

	test('treats a long gap since the last pass as covering every verified domain', () => {
		const domain = newDomain('x', true)
		expect(checkStatus(domain, { from: null, to: T0 }, policy)).toBe('due')
		expect(checkStatus(domain, { from: T0, to: T0 + 2 * 3600 }, policy)).toBe('due')
	})

	test('caps the backoff of a domain that lost verification at the verified recheck interval', () => {
		expect([1, 2, 3, 4, 5, 9].map((failures) => backoffDelaySec(failures, false, policy))).toEqual([
			600, 1800, 3600, 21600, 86400, 86400,
		])
		expect([1, 2, 3, 4, 5].map((failures) => backoffDelaySec(failures, true, policy))).toEqual([
			600, 1800, 3600, 3600, 3600,
		])
	})

	test('reads operator overrides and ignores invalid values', () => {
		expect(
			resolveDnsVerificationPolicy({
				DNS_VERIFIER_VERIFIED_RECHECK_MINUTES: '120',
				DNS_VERIFIER_PARK_AFTER_DAYS: '14',
				DNS_VERIFIER_LAST_CHECKED_REFRESH_HOURS: 'soon',
				DNS_VERIFIER_UNVERIFY_AFTER_MINUTES: '45',
			}),
		).toMatchObject({
			verifiedRecheckSec: 7200,
			parkAfterSec: 14 * 86400,
			lastCheckedRefreshSec: policy.lastCheckedRefreshSec,
			unverifyAfterSec: 2700,
		})
		expect(resolveDnsVerificationPolicy({ DNS_VERIFIER_PARK_AFTER_DAYS: '-1' }).parkAfterSec).toBe(policy.parkAfterSec)
	})
})
