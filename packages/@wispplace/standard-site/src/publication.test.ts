import { describe, expect, test } from 'bun:test'
import { detectStandardSite, documentRkeyForPath, publishStandardSite, type RepoAgent } from './index'

function createMockAgent(): RepoAgent & {
	records: Map<string, Record<string, unknown>>
	deleted: string[]
} {
	const records = new Map<string, Record<string, unknown>>()
	const deleted: string[] = []

	return {
		did: 'did:plc:abc',
		records,
		deleted,
		com: {
			atproto: {
				repo: {
					async getRecord({ repo, collection, rkey }) {
						const key = `${repo}/${collection}/${rkey}`
						const value = records.get(key)
						if (!value) throw new Error('RecordNotFound')
						return { data: { uri: `at://${key}`, cid: `cid:${rkey}`, value } }
					},
					async putRecord({ repo, collection, rkey, record }) {
						const key = `${repo}/${collection}/${rkey}`
						records.set(key, record)
						return { data: { uri: `at://${key}`, cid: `cid:${rkey}` } }
					},
					async listRecords({ repo, collection }) {
						return {
							data: {
								records: [...records.entries()]
									.filter(([key]) => key.startsWith(`${repo}/${collection}/`))
									.map(([key, value]) => ({
										uri: `at://${key}`,
										cid: `cid:${key.split('/').pop()}`,
										value,
									})),
							},
						}
					},
					async deleteRecord({ repo, collection, rkey }) {
						const key = `${repo}/${collection}/${rkey}`
						records.delete(key)
						deleted.push(key)
					},
				},
			},
		},
	}
}

describe('publishStandardSite', () => {
	test('puts publication and document records, then deletes stale documents for the publication', async () => {
		const agent = createMockAgent()
		const did = 'did:plc:abc'
		const siteRkey = 'blog'
		const publicationUri = `at://${did}/site.standard.publication/${siteRkey}`

		agent.records.set(`${did}/site.standard.document/${documentRkeyForPath('/old')}`, {
			$type: 'site.standard.document',
			title: 'old',
			site: publicationUri,
			path: '/old',
			publishedAt: '2025-01-01T00:00:00.000Z',
		})

		const detection = detectStandardSite({
			siteUrl: 'https://example.com',
			siteName: siteRkey,
			files: [
				{
					path: 'dist/blog/new/index.html',
					content:
						'<meta property="og:type" content="article"><meta property="article:published_time" content="2026-01-01"><title>new</title><article>hello</article>',
				},
			],
		})

		const result = await publishStandardSite({
			agent,
			did,
			siteRkey,
			detection,
			now: new Date('2026-01-02T00:00:00.000Z'),
		})

		expect(result.publication.uri).toBe(publicationUri)
		expect(result.documents).toEqual({
			createdOrUpdated: 1,
			deleted: 1,
			skipped: 0,
		})
		expect(agent.records.get(`${did}/site.standard.publication/${siteRkey}`)).toMatchObject({
			$type: 'site.standard.publication',
			url: 'https://example.com',
			name: 'Blog',
			createdAt: '2026-01-02T00:00:00.000Z',
		})
		expect(agent.records.get(`${did}/site.standard.document/${documentRkeyForPath('/blog/new')}`)).toMatchObject({
			$type: 'site.standard.document',
			title: 'new',
			site: publicationUri,
			path: '/blog/new',
			publishedAt: '2026-01-01T00:00:00.000Z',
		})
		expect(agent.deleted).toEqual([`${did}/site.standard.document/${documentRkeyForPath('/old')}`])
	})
})
