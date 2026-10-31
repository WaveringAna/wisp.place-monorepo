import { describe, expect, test } from 'bun:test'
import { CacheManager } from './cache-manager'
import { createHostingDb, type HostingSql } from './db'

// Every subscribeRepos dial to a custom domain asks whether the owner supports wisp; the answer is cached
// either way, so dials cost postgres one read per owner per cache lifetime.
describe('isSupporter', () => {
	test('asks postgres once per DID, caching a no as well as a yes', async () => {
		const asked: string[] = []
		const sql = (async (_strings: TemplateStringsArray, did: string) => {
			asked.push(did)
			return did === 'did:plc:supporter' ? [{}] : []
		}) as unknown as HostingSql
		const { isSupporter } = createHostingDb({
			sql,
			cache: new CacheManager({ domains: {}, customDomains: {}, settings: {}, siteCache: {}, supporters: {} }),
		})

		for (let i = 0; i < 3; i++) {
			expect(await isSupporter('did:plc:supporter')).toBe(true)
			expect(await isSupporter('did:plc:someone')).toBe(false)
		}
		expect(asked).toEqual(['did:plc:supporter', 'did:plc:someone'])
	})
})
