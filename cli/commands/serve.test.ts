import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_REDIRECT_FILE_BYTES } from '@wispplace/fs-utils'
import { handleRequest, loadRedirectRules, MAX_ACTIVE_FILE_STREAMS, normalizeServeRequestPath } from './serve'

const state = (siteDir: string) => ({
	did: 'did:plc:test',
	rkey: 'site',
	pdsEndpoint: 'https://pds.example',
	siteDir,
	settings: null,
	redirectRules: [],
})
const temporaryDirectories: string[] = []
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('normalizeServeRequestPath', () => {
	it('keeps only canonical local request paths', () => {
		expect(normalizeServeRequestPath('/')).toBe('/')
		expect(normalizeServeRequestPath('/assets/app.js')).toBe('/assets/app.js')
		expect(normalizeServeRequestPath('/assets/')).toBe('/assets/')
	})

	it('rejects traversal, encoded structure, Windows paths, and filesystem aliases', () => {
		for (const path of [
			'/../secret.txt',
			'/assets/../secret.txt',
			'/assets%2f..%2fsecret.txt',
			'/safe%00name.txt',
			'/assets\\secret.txt',
			'/C:/Windows/system.ini',
			'/assets/C:/stream',
			'/assets/file.',
			'/assets/file ',
		]) {
			expect(normalizeServeRequestPath(path)).toBeNull()
		}
	})
})

describe('serve boundary', () => {
	it('streams get responses and preserves headers for head', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wispctl-'))
		temporaryDirectories.push(dir)
		writeFileSync(join(dir, 'hello.txt'), 'hello')
		const get = handleRequest(new Request('http://localhost/hello.txt'), state(dir))
		const head = handleRequest(new Request('http://localhost/hello.txt', { method: 'HEAD' }), state(dir))
		expect(await get.text()).toBe('hello')
		expect(get.headers.get('content-length')).toBe('5')
		expect(head.status).toBe(get.status)
		expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'))
		expect(await head.text()).toBe('')
	})

	it('rejects methods other than get and head', () => {
		const response = handleRequest(
			new Request('http://localhost/', { method: 'POST', body: 'ignored' }),
			state(tmpdir()),
		)
		expect(response.status).toBe(405)
		expect(response.headers.get('allow')).toBe('GET, HEAD')
	})

	it('rejects oversized redirects before decoding', () => {
		const dir = mkdtempSync(join(tmpdir(), 'wispctl-'))
		temporaryDirectories.push(dir)
		writeFileSync(join(dir, '_redirects'), Buffer.alloc(MAX_REDIRECT_FILE_BYTES + 1, 0x61))
		expect(loadRedirectRules(dir)).toEqual([])
	})

	it('caps active file streams and releases permits when consumed', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'wispctl-'))
		temporaryDirectories.push(dir)
		writeFileSync(join(dir, 'hello.txt'), 'hello')
		const responses = Array.from({ length: MAX_ACTIVE_FILE_STREAMS }, () =>
			handleRequest(new Request('http://localhost/hello.txt'), state(dir)),
		)
		const saturated = handleRequest(new Request('http://localhost/hello.txt'), state(dir))
		expect(saturated.status).toBe(503)
		await Promise.all(responses.map((response) => response.text()))
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(handleRequest(new Request('http://localhost/hello.txt'), state(dir)).status).toBe(200)
	})
})
