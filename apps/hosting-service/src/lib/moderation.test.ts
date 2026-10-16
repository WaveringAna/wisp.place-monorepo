import { describe, expect, test } from 'bun:test'
import { createTakedowns, DEFAULT_LABELER_DID, resolveLabelerDid, siteSubject } from './moderation'

const ALICE = 'did:plc:abcdefghijklmnopqrstuvwx'

describe('resolveLabelerDid', () => {
	test('defaults to moderation.wisp.place, takes an override and can be switched off', () => {
		expect(resolveLabelerDid({})).toBe(DEFAULT_LABELER_DID)
		expect(resolveLabelerDid({ WISP_LABELER_DID: ' did:plc:other ' })).toBe('did:plc:other')
		expect(resolveLabelerDid({ WISP_LABELER_DID: 'off' })).toBeNull()
	})
})

describe('createTakedowns', () => {
	test('matches a taken-down account or one site, after a load', async () => {
		const takedowns = createTakedowns({ load: async () => [siteSubject(ALICE, 'shop'), 'did:plc:bob'] })
		expect(takedowns.isTakenDown(ALICE, 'shop')).toBe(false)
		await takedowns.refresh()
		expect(takedowns.isTakenDown(ALICE, 'shop')).toBe(true)
		expect(takedowns.isTakenDown(ALICE, 'blog')).toBe(false)
		expect(takedowns.isTakenDown('did:plc:bob', 'anything')).toBe(true)
	})

	test('a failed reload keeps the last good list, and a later one replaces it', async () => {
		let answer: () => Promise<string[]> = async () => [ALICE]
		const takedowns = createTakedowns({ load: () => answer() })
		await takedowns.refresh()
		answer = async () => {
			throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
		}
		await takedowns.refresh()
		expect(takedowns.isTakenDown(ALICE, 'site')).toBe(true)
		answer = async () => []
		await takedowns.refresh()
		expect(takedowns.isTakenDown(ALICE, 'site')).toBe(false)
	})

	test('start loads at once and reloads on its interval until stopped', async () => {
		let loads = 0
		const takedowns = createTakedowns({
			load: async () => {
				loads++
				return []
			},
			refreshIntervalMs: 10,
		})
		await takedowns.start()
		expect(loads).toBe(1)
		await Bun.sleep(35)
		takedowns.stop()
		const after = loads
		expect(after).toBeGreaterThanOrEqual(2)
		await Bun.sleep(30)
		expect(loads).toBe(after)
	})
})
