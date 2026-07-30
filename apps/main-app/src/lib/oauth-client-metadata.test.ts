import { describe, expect, test } from 'bun:test'
import { createClientMetadata } from './oauth-client'

describe('createClientMetadata', () => {
	test('keeps the client URI on the configured origin', () => {
		const metadata = createClientMetadata(
			{
				domain: 'https://staging.wisp.place',
				clientName: 'Wisp Staging',
			},
			false,
		)

		expect(metadata.client_id).toBe('https://staging.wisp.place/oauth-client-metadata.json')
		expect(metadata.client_uri).toBe('https://staging.wisp.place')
	})
})
