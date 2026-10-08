import { describe, expect, test } from 'bun:test'
import { flagSitesNeedingAttention, type SiteFenceReader } from './site-attention'

const sites = [
	{ did: 'did:plc:a', rkey: 'fenced' },
	{ did: 'did:plc:a', rkey: 'fine' },
]
const reader = (reply: (keys: string[]) => Promise<unknown>) => async (): Promise<SiteFenceReader> => ({
	send: (_command, keys) => reply(keys),
})

describe('flagSitesNeedingAttention', () => {
	test('flags exactly the fenced sites, including an empty fence value', async () => {
		const flagged = await flagSitesNeedingAttention(
			sites,
			reader(async (keys) => keys.map((key) => (key.endsWith('/fenced') ? '' : null))),
		)
		expect(flagged).toEqual([{ did: 'did:plc:a', rkey: 'fenced', needs_attention: true }, sites[1]!])
	})

	test('leaves the list unflagged without Redis, on errors and when Redis is slow', async () => {
		expect(await flagSitesNeedingAttention(sites, async () => null)).toEqual(sites)
		expect(
			await flagSitesNeedingAttention(
				sites,
				reader(async () => {
					throw new Error('connection refused')
				}),
			),
		).toEqual(sites)
		const started = Date.now()
		expect(
			await flagSitesNeedingAttention(
				sites,
				reader(() => new Promise(() => undefined)),
			),
		).toEqual(sites)
		expect(Date.now() - started).toBeLessThan(2_000)
	})

	test('does not touch Redis for an empty list', async () => {
		let calls = 0
		await flagSitesNeedingAttention([], async () => {
			calls++
			return null
		})
		expect(calls).toBe(0)
	})
})
