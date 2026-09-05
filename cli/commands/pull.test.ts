import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
	createLogicalSiteBudget,
	decompressPulledGzip,
	readPulledBlob,
	resolvePullFilePath,
	validatePulledGzipHeader,
} from './pull'

const temporaryPaths: string[] = []

function makeTempDirectory(): string {
	const path = mkdtempSync(join(tmpdir(), 'wisp-pull-path-'))
	temporaryPaths.push(path)
	return path
}

afterEach(() => {
	for (const path of temporaryPaths.splice(0)) {
		rmSync(path, { recursive: true, force: true })
	}
})

describe('resolvePullFilePath', () => {
	it('accepts only canonical site-relative paths on POSIX and Windows', () => {
		const root = makeTempDirectory()
		const target = resolvePullFilePath(root, 'assets/app.js', true)

		expect(target).toBe(join(realpathSync(root), 'assets', 'app.js'))
		for (const path of [
			'../outside.txt',
			'..\\outside.txt',
			'C:/outside.txt',
			'C:\\outside.txt',
			'nested//file.txt',
			'index.html:stream',
			'file.',
			'file ',
			'CON.txt',
		]) {
			expect(() => resolvePullFilePath(root, path, true)).toThrow('invalid file path')
		}
	})

	it('rejects child and final symlinks instead of resolving outside the pull root', () => {
		const root = makeTempDirectory()
		const outside = makeTempDirectory()
		mkdirSync(join(root, 'assets'))
		const linkType = process.platform === 'win32' ? 'junction' : 'dir'
		symlinkSync(outside, join(root, 'assets', 'linked'), linkType)
		symlinkSync(join(outside, 'target.txt'), join(root, 'file.txt'))

		const linkContainer = makeTempDirectory()
		const rootLink = join(linkContainer, 'root-link')
		symlinkSync(root, rootLink, linkType)

		expect(() => resolvePullFilePath(root, 'assets/linked/escape.txt', true)).toThrow('unsafe directory')
		expect(() => resolvePullFilePath(root, 'file.txt', true)).toThrow('symbolic link')
		expect(() => resolvePullFilePath(rootLink, 'inside.txt', true)).toThrow('Pull root')
	})
})

describe('decompressPulledGzip', () => {
	it('rejects a gzip expansion over the supplied bounded output limit', async () => {
		const compressed = gzipSync(Buffer.alloc(8 * 1024, 'x'))
		await expect(decompressPulledGzip(compressed, 1024)).rejects.toThrow('Could not safely decompress gzip blob')
	})

	it('keeps a valid expansion at its inclusive output limit', async () => {
		const original = Buffer.alloc(1024, 'x')
		expect(await decompressPulledGzip(gzipSync(original), original.byteLength)).toEqual(original)
	})
})

describe('pull safety budgets', () => {
	it('rejects gzip metadata without a gzip header', () => {
		expect(() => validatePulledGzipHeader(Buffer.from('plain text'))).toThrow('not a gzip stream')
	})

	it('enforces the inclusive aggregate logical site limit', () => {
		const budget = createLogicalSiteBudget(10)
		budget.reserve(6)
		budget.reserve(4)
		expect(budget.totalSize).toBe(10)
		expect(() => budget.reserve(1)).toThrow('logical size limit')
	})
})

describe('readPulledBlob', () => {
	it('cancels an oversized blob response before retaining its full body', async () => {
		await expect(readPulledBlob(new Response(Buffer.alloc(1025)), 1024)).rejects.toThrow(
			'Downloaded blob exceeds the 1024-byte limit',
		)
	})

	it('returns a blob exactly at its inclusive byte limit', async () => {
		const body = Buffer.alloc(1024, 'x')
		expect(await readPulledBlob(new Response(body), body.byteLength)).toEqual(body)
	})
})
