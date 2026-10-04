import { describe, expect, test } from 'bun:test'
import {
	applyMarqueDns,
	type MarqueEntry,
	type MarquePorts,
	marqueApex,
	marqueStatus,
	planZone,
	relativeName,
	type StoredZone,
	wispEntries,
} from './marque-dns'

const DID = 'did:plc:alice'
const TARGET = 'abc123.dns.wisp.place'
const MARQUE_NS = ['stratus.mqdns.de', 'cirrus.mqdns.at', 'nimbus.mqdns.app']

const entry = (name: string, recordType: string, value: string, ttl = 300): MarqueEntry => ({
	name,
	recordType,
	value,
	ttl,
})

/** A zone like a real one: mail, verification for other services, a www host. */
const ZONE: MarqueEntry[] = [
	entry('@', 'MX', 'mail.example.com'),
	entry('@', 'TXT', 'v=spf1 include:mail.example.com ~all'),
	entry('_atproto', 'TXT', 'did=did:plc:alice', 60),
	entry('_dmarc', 'TXT', 'v=DMARC1; p=none'),
	entry('www', 'A', '192.0.2.1'),
]

describe('placing a domain in its marque zone', () => {
	test('picks the longest owned apex the domain sits under', () => {
		expect(marqueApex('blog.example.com', ['example.com', 'other.com'])).toBe('example.com')
		expect(marqueApex('a.b.example.co.uk', ['example.co.uk', 'b.example.co.uk'])).toBe('b.example.co.uk')
		expect(marqueApex('example.com', ['EXAMPLE.COM.'])).toBe('example.com')
		expect(marqueApex('notexample.com', ['example.com'])).toBeNull()
	})

	test('names records relative to the zone, @ for the apex', () => {
		expect(relativeName('example.com', 'example.com')).toBe('@')
		expect(relativeName('blog.example.com', 'example.com')).toBe('blog')
		expect(relativeName('a.b.example.com', 'example.com')).toBe('a.b')
	})

	test('puts the ownership TXT at _wisp under the domain', () => {
		expect(wispEntries({ domain: 'example.com', apex: 'example.com', did: DID, target: TARGET })).toEqual([
			entry('@', 'CNAME', TARGET),
			entry('_wisp', 'TXT', DID),
		])
		expect(
			wispEntries({ domain: 'blog.example.com', apex: 'example.com', did: DID, target: TARGET }).map((e) => e.name),
		).toEqual(['blog', '_wisp.blog'])
	})
})

describe('planning the zone write', () => {
	const blog = wispEntries({ domain: 'blog.example.com', apex: 'example.com', did: DID, target: TARGET })
	const apex = wispEntries({ domain: 'example.com', apex: 'example.com', did: DID, target: TARGET })

	test('adds both records and keeps every other record exactly as it was', () => {
		const plan = planZone(ZONE, blog)
		expect(plan).toEqual({ kind: 'write', records: [...ZONE, ...blog] })
	})

	test('keeps mail and other apex records when pointing the apex itself', () => {
		expect(planZone(ZONE, apex)).toEqual({ kind: 'write', records: [...ZONE, ...apex] })
	})

	test('does nothing when the records are already there, however they are spelled', () => {
		const spelled = [
			...ZONE,
			entry('BLOG', 'CNAME', `${TARGET.toUpperCase()}.`),
			entry('_wisp.blog', 'TXT', `"${DID}"`),
		]
		expect(planZone(spelled, blog)).toEqual({ kind: 'unchanged' })
	})

	test('only adds what is missing', () => {
		const half = [...ZONE, blog[1]]
		expect(planZone(half, blog)).toEqual({ kind: 'write', records: [...half, blog[0]] })
	})

	test.each([
		['an address at the domain', entry('blog', 'A', '192.0.2.9')],
		['another CNAME at the domain', entry('blog', 'CNAME', 'old-host.example.net')],
		['anything else below the apex, which a CNAME can not share a name with', entry('blog', 'TXT', 'hello')],
		['another ownership TXT', entry('_wisp.blog', 'TXT', 'did:plc:someone-else')],
	])('stops at %s', (_, inTheWay) => {
		expect(planZone([...ZONE, inTheWay], blog)).toEqual({ kind: 'conflict', conflicts: [inTheWay] })
	})

	test('stops at an address on the apex but not at its mail', () => {
		const old = entry('@', 'A', '192.0.2.7')
		expect(planZone([...ZONE, old], apex)).toEqual({ kind: 'conflict', conflicts: [old] })
	})

	test('replacing drops exactly the records in the way', () => {
		const old = entry('blog', 'A', '192.0.2.9')
		expect(planZone([...ZONE, old], blog, true)).toEqual({ kind: 'write', records: [...ZONE, ...blog] })
	})

	test('replacing still keeps a record that is ours', () => {
		const zone = [...ZONE, blog[0], entry('_wisp.blog', 'TXT', 'did:plc:old')]
		expect(planZone(zone, blog, true)).toEqual({ kind: 'write', records: [...ZONE, blog[0], blog[1]] })
	})
})

const fakePorts = (overrides: Partial<MarquePorts> = {}, zone: MarqueEntry[] = ZONE) => {
	let stored: StoredZone | null = {
		cid: 'cid-0',
		value: { $type: 'at.marque.dns', domain: 'example.com', subject: { uri: 'at://x', cid: 'y' }, records: zone },
	}
	const writes: { value: StoredZone['value']; swapCid: string }[] = []
	const ports: MarquePorts = {
		ownedDomains: async () => [{ domain: 'example.com', nameServers: MARQUE_NS }],
		liveNameservers: async () => MARQUE_NS,
		getZone: async () => stored,
		putZone: async (_, value, swapCid) => {
			if (swapCid !== stored?.cid) return false
			writes.push({ value, swapCid })
			stored = { cid: `cid-${writes.length}`, value }
			return true
		},
		...overrides,
	}
	return {
		ports,
		writes,
		edit: (records: MarqueEntry[]) => {
			stored = { cid: `${stored?.cid}-edited`, value: { ...stored!.value, records } }
		},
	}
}

const BLOG = { domain: 'blog.example.com', did: DID, target: TARGET }

describe('marque status', () => {
	test('is ready for a domain under an apex marque serves', async () => {
		const { ports } = fakePorts()
		expect(await marqueStatus(ports, BLOG)).toEqual({
			managed: true,
			apex: 'example.com',
			state: 'ready',
			conflicts: [],
		})
	})

	test.each([
		['the account did not register the apex through marque', { ownedDomains: async () => [] }],
		['the apex moved to other nameservers', { liveNameservers: async () => ['ns1.cloudflare.com'] }],
		['only some nameservers are marque', { liveNameservers: async () => ['stratus.mqdns.de', 'ns1.other.net'] }],
		['the nameservers could not be looked up', { liveNameservers: async () => [] }],
		['there is no zone record', { getZone: async () => null }],
	])('is unmanaged when %s', async (_, overrides) => {
		const { ports } = fakePorts(overrides as Partial<MarquePorts>)
		expect(await marqueStatus(ports, BLOG)).toEqual({ managed: false })
	})

	test('reports what is in the way', async () => {
		const old = entry('blog', 'CNAME', 'old-host.example.net')
		const { ports } = fakePorts({}, [...ZONE, old])
		expect(await marqueStatus(ports, BLOG)).toMatchObject({ state: 'conflict', conflicts: [old] })
	})
})

describe('applying marque dns', () => {
	test('writes the merged zone against the cid it read, keeping the rest of the record', async () => {
		const { ports, writes } = fakePorts()
		expect(await applyMarqueDns(ports, BLOG)).toEqual({ state: 'done' })
		expect(writes).toHaveLength(1)
		expect(writes[0]?.swapCid).toBe('cid-0')
		expect(writes[0]?.value).toMatchObject({
			$type: 'at.marque.dns',
			domain: 'example.com',
			subject: { uri: 'at://x' },
		})
		expect(writes[0]?.value.records).toEqual([...ZONE, ...wispEntries({ ...BLOG, apex: 'example.com' })])
	})

	test('does not write when nothing is missing', async () => {
		const { ports, writes } = fakePorts({}, [...ZONE, ...wispEntries({ ...BLOG, apex: 'example.com' })])
		expect(await applyMarqueDns(ports, BLOG)).toEqual({ state: 'done' })
		expect(writes).toHaveLength(0)
	})

	test('writes nothing when something is in the way', async () => {
		const old = entry('blog', 'A', '192.0.2.9')
		const { ports, writes } = fakePorts({}, [...ZONE, old])
		expect(await applyMarqueDns(ports, BLOG)).toEqual({ state: 'conflict', conflicts: [old] })
		expect(writes).toHaveLength(0)
	})

	test('replaces what is in the way when asked', async () => {
		const { ports, writes } = fakePorts({}, [...ZONE, entry('blog', 'A', '192.0.2.9')])
		expect(await applyMarqueDns(ports, BLOG, true)).toEqual({ state: 'done' })
		expect(writes[0]?.value.records).toEqual([...ZONE, ...wispEntries({ ...BLOG, apex: 'example.com' })])
	})

	test('re-reads and keeps an edit made between the read and the write', async () => {
		const fake = fakePorts()
		const added = entry('shop', 'CNAME', 'shops.example.net')
		const putZone = fake.ports.putZone
		let raced = false
		fake.ports.putZone = async (apex, value, swapCid) => {
			if (!raced) {
				raced = true
				fake.edit([...ZONE, added])
			}
			return await putZone(apex, value, swapCid)
		}
		expect(await applyMarqueDns(fake.ports, BLOG)).toEqual({ state: 'done' })
		expect(fake.writes).toHaveLength(1)
		expect(fake.writes[0]?.value.records).toEqual([...ZONE, added, ...wispEntries({ ...BLOG, apex: 'example.com' })])
	})

	test('gives up rather than overwrite a zone that keeps changing', async () => {
		const { ports, writes } = fakePorts({ putZone: async () => false })
		await expect(applyMarqueDns(ports, BLOG)).rejects.toThrow('kept changing')
		expect(writes).toHaveLength(0)
	})

	test('refuses a domain marque does not serve', async () => {
		const { ports, writes } = fakePorts({ ownedDomains: async () => [] })
		expect(await applyMarqueDns(ports, BLOG)).toEqual({ state: 'unmanaged' })
		expect(writes).toHaveLength(0)
	})
})
