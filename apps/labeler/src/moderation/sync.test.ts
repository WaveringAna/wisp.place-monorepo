import { describe, expect, test } from 'bun:test'
import { resolveHandleFromDidDoc } from './sync'

describe('resolveHandleFromDidDoc', () => {
	// A did:web names the host its document is fetched from, so the account picks the URL.
	test.each([
		['a private address', 'did:web:10.88.0.10'],
		['a private address with a port', 'did:web:192.168.1.1%3A8899'],
		['loopback', 'did:web:127.0.0.1%3A5432'],
		['localhost', 'did:web:localhost%3A8080'],
		['the tailnet range', 'did:web:100.64.0.11'],
	])('refuses a did:web host on %s', async (_name, did) => {
		await expect(resolveHandleFromDidDoc(did)).rejects.toMatchObject({ kind: 'blocked_destination' })
	})
})
