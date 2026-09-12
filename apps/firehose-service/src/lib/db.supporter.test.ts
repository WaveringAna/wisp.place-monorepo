import { expect, test } from 'bun:test'
import { isSupporter } from './db'

test('supporter admission preserves cancellation without starting a database query', async () => {
	const controller = new AbortController()
	const stopped = new Error('preflight stopped')
	controller.abort(stopped)
	await expect(isSupporter('did:plc:test', controller.signal)).rejects.toBe(stopped)
})
