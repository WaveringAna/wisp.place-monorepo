import { describe, expect, test } from 'bun:test'
import {
	ABSENT_SITE_PURGE_MIN_AGE_SECONDS,
	type AbsentSiteSweeperDependencies,
	decideAbsentSiteAction,
	sweepAbsentSites,
} from './absent-site-sweeper'
import type { SiteRecordFetchOutcome } from './cache-writer'
import type { AbsentSiteMark } from './db'

const NOW = 2_000_000_000
const OLD = NOW - ABSENT_SITE_PURGE_MIN_AGE_SECONDS
const confirmed: SiteRecordFetchOutcome = { kind: 'absent', confirmed: true }

describe('decideAbsentSiteAction', () => {
	test('restores a site whose record is back', () => {
		const present = { kind: 'present', record: {} as never, cid: 'bafy' } as const
		expect(decideAbsentSiteAction(present, null, NOW)).toBe('restore')
	})

	test('never acts on an unreachable PDS or an unconfirmed 404', () => {
		const mark = { absent_since: OLD - 1, absent_checks: 99 }
		expect(decideAbsentSiteAction({ kind: 'retryable', error: 'FETCH_FAILED' }, mark, NOW)).toBe('skip')
		expect(decideAbsentSiteAction({ kind: 'retryable', error: 'PDS_UNRESOLVED' }, mark, NOW)).toBe('skip')
		expect(decideAbsentSiteAction({ kind: 'absent', confirmed: false }, mark, NOW)).toBe('skip')
		expect(decideAbsentSiteAction({ kind: 'absent' }, mark, NOW)).toBe('skip')
	})

	test('keeps counting inside the grace period', () => {
		expect(decideAbsentSiteAction(confirmed, { absent_since: NOW - 60, absent_checks: 10 }, NOW)).toBe('count')
		expect(decideAbsentSiteAction(confirmed, { absent_since: OLD - 1, absent_checks: 2 }, NOW)).toBe('count')
	})

	test('purges only after enough confirmations over the full grace period', () => {
		expect(decideAbsentSiteAction(confirmed, { absent_since: OLD, absent_checks: 3 }, NOW)).toBe('purge')
		expect(decideAbsentSiteAction(confirmed, { absent_since: String(OLD) as never, absent_checks: 3 }, NOW)).toBe(
			'purge',
		)
	})
})

describe('sweepAbsentSites', () => {
	function fakeDependencies(
		outcomes: Record<string, SiteRecordFetchOutcome | Error>,
		marks: Record<string, AbsentSiteMark>,
	) {
		const calls: string[] = []
		const dependencies: AbsentSiteSweeperDependencies = {
			listAbsentSites: async () => Object.values(marks),
			fetchSiteRecordOutcome: async (did) => {
				const outcome = outcomes[did]!
				if (outcome instanceof Error) throw outcome
				return outcome
			},
			markSiteAbsent: async (did) => {
				const mark = marks[did]!
				mark.absent_checks++
				calls.push(`mark ${did}`)
				return mark
			},
			clearSiteAbsent: async (did) => {
				calls.push(`clear ${did}`)
				return true
			},
			handleSiteDelete: async (did) => {
				calls.push(`delete ${did}`)
			},
			publishCacheInvalidation: async (did) => {
				calls.push(`invalidate ${did}`)
			},
			now: () => NOW,
		}
		return { dependencies, calls }
	}

	const mark = (did: string, absent_since: number, absent_checks: number): AbsentSiteMark => ({
		did,
		rkey: 'site',
		absent_since,
		absent_checks,
	})

	test('restores, counts, purges and skips per site, and never deletes an unreachable one', async () => {
		const { dependencies, calls } = fakeDependencies(
			{
				back: { kind: 'present', record: {} as never, cid: 'bafy' },
				young: confirmed,
				old: confirmed,
				away: { kind: 'retryable', error: 'FETCH_FAILED' },
				broken: new Error('boom'),
			},
			{
				back: mark('back', OLD, 5),
				young: mark('young', NOW - 3600, 0),
				old: mark('old', OLD, 2),
				away: mark('away', OLD - 999_999, 50),
				broken: mark('broken', OLD, 9),
			},
		)

		const result = await sweepAbsentSites(undefined, dependencies)

		expect(result).toEqual({ checked: 5, restored: 1, counted: 1, purged: 1, skipped: 2 })
		expect(calls).toContain('clear back')
		expect(calls).toContain('invalidate back')
		expect(calls).toContain('mark young')
		expect(calls).toContain('delete old')
		expect(calls.filter((call) => call.endsWith(' away'))).toEqual([])
		expect(calls.filter((call) => call.startsWith('delete') && !call.endsWith(' old'))).toEqual([])
	})
})
