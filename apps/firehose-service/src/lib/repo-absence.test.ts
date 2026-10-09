import { describe, expect, test } from 'bun:test'
import { type RepoProbeOutcome, readRepoProbeResponse } from './cache-writer'
import {
	DEFAULT_REPO_ABSENCE_POLICY,
	decideRepoAbsence,
	type RepoAbsenceState,
	repoAbsencePolicyFromEnv,
} from './repo-absence'

const HOUR = 60 * 60_000
const policy = DEFAULT_REPO_ABSENCE_POLICY
const OLD_PDS = 'https://pds.old.example'
const NEW_PDS = 'https://pds.new.example'
const gone = (pds = OLD_PDS): RepoProbeOutcome => ({ kind: 'repo-absent', pds })
const down: RepoProbeOutcome = { kind: 'unavailable', reason: 'HTTP_503' }

/** Feed answers one probe interval apart, starting at t=0, and return every decision. */
function run(answers: RepoProbeOutcome[], interval = policy.probeIntervalMs, start: RepoAbsenceState | null = null) {
	let state = start
	return answers.map((answer, index) => {
		const decision = decideRepoAbsence(state, answer, index * interval, policy)
		state = decision.state
		return decision
	})
}

describe('decideRepoAbsence', () => {
	test('confirms only after the minimum checks spanning the minimum duration', () => {
		const decisions = run([gone(), gone(), gone(), gone()])
		expect(decisions.map(({ action }) => action)).toEqual(['counted', 'counted', 'counted', 'confirmed'])
		// Three RepoNotFound answers in 16 h are not enough; the fourth, 24 h after the first, is.
		expect(decisions[2]!.state.checks).toBe(3)
		expect(decisions[3]!.state).toMatchObject({ checks: 4, firstAt: 0, confirmedAt: 24 * HOUR, pds: OLD_PDS })
		expect(decisions[3]!.state.nextAt).toBe(24 * HOUR + policy.probeIntervalMs)
	})

	test('a single RepoNotFound never confirms, however old the first sighting', () => {
		const [first] = run([gone()])
		expect(first!.action).toBe('counted')
		expect(first!.state.confirmedAt).toBeUndefined()
		const later = decideRepoAbsence(first!.state, gone(), 30 * 24 * HOUR, policy)
		expect(later.action).toBe('counted')
		expect(later.state.checks).toBe(2)
	})

	test('answers closer together than half a probe interval count once', () => {
		const decisions = run(
			Array.from({ length: 30 }, () => gone()),
			60_000,
		)
		expect(decisions.every(({ state }) => state.checks === 1)).toBe(true)
		expect(decisions.slice(1).every(({ action }) => action === 'unchanged')).toBe(true)
	})

	test('a DID document that now names a different PDS restarts the count', () => {
		const decisions = run([gone(), gone(), gone(NEW_PDS), gone(NEW_PDS), gone(NEW_PDS), gone(NEW_PDS)])
		expect(decisions.map(({ action }) => action)).toEqual([
			'counted',
			'counted',
			'reset',
			'counted',
			'counted',
			'confirmed',
		])
		expect(decisions[2]!.state).toMatchObject({ pds: NEW_PDS, checks: 1, firstAt: 16 * HOUR })
	})

	test('a migration that lands on the new PDS resets instead of confirming', () => {
		const decisions = run([gone(), gone(), { kind: 'present' }, gone(), gone()])
		expect(decisions.map(({ action }) => action)).toEqual(['counted', 'counted', 'reset', 'counted', 'counted'])
		expect(decisions[decisions.length - 1]!.state.confirmedAt).toBeUndefined()
	})

	test('a repo whose record is missing is not a gone repo', () => {
		const decisions = run([gone(), { kind: 'record-absent', pds: OLD_PDS }])
		expect(decisions[1]).toMatchObject({ action: 'reset', state: { checks: 0, pds: null } })
	})

	test('PDS 5xx, timeouts, deactivation and takedown neither count nor reset', () => {
		const answers: RepoProbeOutcome[] = [
			gone(),
			down,
			{ kind: 'unavailable', reason: 'FETCH_FAILED' },
			{ kind: 'unavailable', reason: 'RepoDeactivated' },
			{ kind: 'unavailable', reason: 'RepoTakendown' },
			{ kind: 'unavailable', reason: 'PDS_UNRESOLVED' },
		]
		const decisions = run(answers)
		expect(decisions.slice(1).map(({ action }) => action)).toEqual([
			'unchanged',
			'unchanged',
			'unchanged',
			'unchanged',
			'unchanged',
		])
		expect(decisions[decisions.length - 1]!.state).toMatchObject({ checks: 1, firstAt: 0, pds: OLD_PDS })
		// The count survives the outage: two more RepoNotFound answers past 24 h confirm.
		const resumed = decideRepoAbsence(decisions[decisions.length - 1]!.state, gone(), 48 * HOUR, policy)
		expect(resumed.action).toBe('counted')
		expect(decideRepoAbsence(resumed.state, gone(), 56 * HOUR, policy).action).toBe('confirmed')
	})

	test('a flaky PDS that answers the record between RepoNotFounds never confirms', () => {
		const decisions = run([gone(), down, { kind: 'present' }, gone(), down, gone()])
		expect(decisions.some(({ action }) => action === 'confirmed')).toBe(false)
	})

	test('a PLC tombstone confirms at once', () => {
		const [decision] = run([{ kind: 'did-tombstoned' }])
		expect(decision).toMatchObject({ action: 'confirmed', state: { confirmedAt: 0, pds: null } })
	})

	test('a confirmed site stays confirmed until the repo answers, then restores', () => {
		const confirmed = run([gone(), gone(), gone(), gone()])[3]!.state
		const still = decideRepoAbsence(confirmed, gone(), 48 * HOUR, policy)
		expect(still.action).toBe('unchanged')
		expect(still.state.confirmedAt).toBe(confirmed.confirmedAt)
		expect(decideRepoAbsence(still.state, down, 72 * HOUR, policy).state.confirmedAt).toBe(confirmed.confirmedAt)
		const back = decideRepoAbsence(still.state, { kind: 'present' }, 96 * HOUR, policy)
		expect(back.action).toBe('restored')
		expect(back.state.confirmedAt).toBeUndefined()
		expect(back.state.checks).toBe(0)
	})
})

describe('repoAbsencePolicyFromEnv', () => {
	test('reads the knobs and refuses values below the floors', () => {
		expect(repoAbsencePolicyFromEnv({})).toEqual(policy)
		expect(
			repoAbsencePolicyFromEnv({
				WISP_REPO_ABSENCE_MIN_CHECKS: '5',
				WISP_REPO_ABSENCE_MIN_HOURS: '72',
				WISP_REPO_ABSENCE_PROBE_HOURS: '12',
			}),
		).toEqual({ minChecks: 5, minSpanMs: 72 * HOUR, probeIntervalMs: 12 * HOUR })
		expect(
			repoAbsencePolicyFromEnv({
				WISP_REPO_ABSENCE_MIN_CHECKS: '1',
				WISP_REPO_ABSENCE_MIN_HOURS: '0',
				WISP_REPO_ABSENCE_PROBE_HOURS: 'soon',
			}),
		).toEqual(policy)
	})
})

describe('readRepoProbeResponse', () => {
	const respond = (status: number, body: unknown) =>
		readRepoProbeResponse(new Response(JSON.stringify(body), { status }), OLD_PDS)

	test('only an HTTP 400 RepoNotFound (or the older "Could not find repo") is a gone repo', async () => {
		expect(await respond(400, { error: 'RepoNotFound', message: 'Could not find repo for DID' })).toEqual(gone())
		expect(await respond(400, { error: 'InvalidRequest', message: 'Could not find repo: did:plc:x' })).toEqual(gone())
		expect(await respond(404, { error: 'RepoNotFound' })).toEqual({ kind: 'unavailable', reason: 'HTTP_404' })
		expect(await respond(400, { error: 'InvalidRequest', message: 'Something else' })).toEqual({
			kind: 'unavailable',
			reason: 'HTTP_400',
		})
	})

	test('deactivation and takedown stay unavailable, a record answer is present', async () => {
		expect(await respond(400, { error: 'RepoDeactivated' })).toEqual({ kind: 'unavailable', reason: 'RepoDeactivated' })
		expect(await respond(400, { error: 'RepoTakendown' })).toEqual({ kind: 'unavailable', reason: 'RepoTakendown' })
		expect(await respond(502, { error: 'RepoNotFound' })).toEqual({ kind: 'unavailable', reason: 'HTTP_502' })
		expect(await respond(400, { error: 'RecordNotFound' })).toEqual({ kind: 'record-absent', pds: OLD_PDS })
		expect(await respond(200, { uri: 'at://x', value: {} })).toEqual({ kind: 'present' })
		expect(await readRepoProbeResponse(new Response('<html>bad gateway</html>', { status: 400 }), OLD_PDS)).toEqual({
			kind: 'unavailable',
			reason: 'HTTP_400',
		})
	})
})
