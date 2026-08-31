import { describe, expect, mock, test } from 'bun:test'
import { MAX_FILE_COUNT, MAX_FILE_SIZE, MAX_SITE_SIZE } from '@wispplace/constants'

const SENTINEL = 'PDS_TOKEN_MUST_NOT_BE_EXPOSED'
const logs: unknown[] = []

mock.module('@wispplace/observability', () => ({
	createLogger: () => ({
		debug: (...args: unknown[]) => logs.push(args),
		error: (...args: unknown[]) => logs.push(args),
		info: (...args: unknown[]) => logs.push(args),
		warn: (...args: unknown[]) => logs.push(args),
	}),
}))

const { createUploadJob, getUploadJob, getUploadJobStats } = await import('../lib/upload-jobs')

const {
	collectOwnedSubfsSubjects,
	INVALID_UPLOAD_MESSAGE,
	processUploadInBackground,
	selectPublicUploadFiles,
	PublicUploadError,
	UPLOAD_CONFLICT_MESSAGE,
	UPLOAD_FAILED_MESSAGE,
	UPLOAD_TOO_LARGE_MESSAGE,
	validatePublicUploadFiles,
} = await import('../lib/public-upload')

const fakeFile = (name: string, size: number, type = 'text/plain'): File =>
	({
		name,
		size,
		type,
		arrayBuffer: async () => new ArrayBuffer(0),
		text: async () => '',
	}) as unknown as File

const expectPublicError = (callback: () => unknown, status: number, message: string) => {
	try {
		callback()
		expect.unreachable('expected public upload error')
	} catch (error) {
		expect(error).toBeInstanceOf(PublicUploadError)
		expect(error).toMatchObject({ status, message })
	}
}

describe('public upload metadata validation', () => {
	test('rejects 1001 raw multipart file entries before reading them', () => {
		const files = Array.from({ length: MAX_FILE_COUNT + 1 }, (_, index) => fakeFile(`${index}.txt`, 0))
		expectPublicError(() => validatePublicUploadFiles(files, MAX_SITE_SIZE), 413, UPLOAD_TOO_LARGE_MESSAGE)

		const metadataTrap = new Proxy(
			{},
			{
				get: () => {
					throw new Error(SENTINEL)
				},
			},
		)
		expectPublicError(
			() => validatePublicUploadFiles(Array(MAX_FILE_COUNT + 1).fill(metadataTrap), MAX_SITE_SIZE),
			413,
			UPLOAD_TOO_LARGE_MESSAGE,
		)
	})

	test('uses original logical bytes, not gzip output, for site quota', () => {
		const compressibleFiles = [
			fakeFile('first.txt', MAX_FILE_SIZE, 'text/plain'),
			fakeFile('second.txt', MAX_FILE_SIZE, 'text/plain'),
		]
		expectPublicError(() => validatePublicUploadFiles(compressibleFiles, MAX_SITE_SIZE), 413, UPLOAD_TOO_LARGE_MESSAGE)
	})

	test('rejects traversal, duplicate normalized paths, reserved internals, and huge names', () => {
		for (const files of [
			[fakeFile('site/../index.html', 1)],
			[fakeFile('site/index.html', 1), fakeFile('site/index.html', 1)],
			[fakeFile('site/foo', 1), fakeFile('site/foo/index.html', 1)],
			[fakeFile('__subfs_1', 1)],
			[fakeFile('＿＿subfs_1', 1)],
			[fakeFile('__proto__/polluted.html', 1)],
			[fakeFile(`${SENTINEL}-${'x'.repeat(5_000)}`, 1)],
		]) {
			try {
				validatePublicUploadFiles(files, MAX_SITE_SIZE)
				expect.unreachable('expected invalid upload')
			} catch (error) {
				expect(error).toMatchObject({ status: 400, message: INVALID_UPLOAD_MESSAGE })
				expect(String((error as Error).message)).not.toContain(SENTINEL)
			}
		}
	})

	test('accepts exact per-file and logical quota boundaries', () => {
		const perFileBoundary = validatePublicUploadFiles([fakeFile('asset.bin', MAX_FILE_SIZE)], MAX_FILE_SIZE)
		expect(perFileBoundary).toHaveLength(1)

		const logicalBoundary = validatePublicUploadFiles(
			[fakeFile('first.bin', MAX_FILE_SIZE), fakeFile('second.bin', MAX_SITE_SIZE - MAX_FILE_SIZE)],
			MAX_SITE_SIZE,
		)
		expect(logicalBoundary).toHaveLength(2)
		expectPublicError(
			() => validatePublicUploadFiles([fakeFile('asset.bin', MAX_FILE_SIZE + 1)], MAX_SITE_SIZE),
			413,
			UPLOAD_TOO_LARGE_MESSAGE,
		)
	})

	test('strips only explicit browser directory paths, not common file-name prefixes', () => {
		const namedFiles = validatePublicUploadFiles(
			[fakeFile('folder/a.html', 1), fakeFile('folder/b.html', 1)],
			MAX_SITE_SIZE,
		)
		expect(namedFiles.map((file) => file.path)).toEqual(['folder/a.html', 'folder/b.html'])

		const directoryFiles = [
			Object.assign(fakeFile('a.html', 1), { webkitRelativePath: 'folder/a.html' }),
			Object.assign(fakeFile('b.html', 1), { webkitRelativePath: 'folder/b.html' }),
		]
		expect(validatePublicUploadFiles(directoryFiles, MAX_SITE_SIZE).map((file) => file.path)).toEqual([
			'a.html',
			'b.html',
		])
	})

	test('bounds ignored-file progress metadata', async () => {
		const files = validatePublicUploadFiles(
			Array.from({ length: MAX_FILE_COUNT }, (_, index) => fakeFile(`node_modules/${index}.js`, 0)),
			MAX_SITE_SIZE,
		)
		const selected = await selectPublicUploadFiles(files)
		expect(selected.files).toHaveLength(0)
		expect(selected.skippedFiles).toHaveLength(50)
	})

	test('cannot publish .wispignore or negate server VCS/secret ignore rules', async () => {
		const ignoreFile = Object.assign(fakeFile('.wispignore', 10), { text: async () => '!node_modules/**' })
		const files = validatePublicUploadFiles(
			[ignoreFile, fakeFile('node_modules/secret.js', 1), fakeFile('index.html', 1)],
			MAX_SITE_SIZE,
		)
		const selected = await selectPublicUploadFiles(files)
		expect(selected.files.map((file) => file.path)).toEqual(['index.html'])
		expect(selected.skippedFiles).toHaveLength(2)
	})
})

describe('public upload failures and SubFS cleanup', () => {
	test('does not expose a PDS failure or publish a partial manifest', async () => {
		logs.length = 0
		const did = `did:example:failure${crypto.randomUUID().replaceAll('-', '')}`
		const jobId = createUploadJob(did, 'failure-site', 1)
		let putRecordCalls = 0
		const pdsFailure = Object.assign(new Error(SENTINEL), { status: 500 })
		const agent = {
			com: {
				atproto: {
					repo: {
						getRecord: async () => {
							throw { error: 'RecordNotFound' }
						},
						uploadBlob: async () => {
							throw pdsFailure
						},
						putRecord: async () => {
							putRecordCalls++
							return { data: { uri: 'at://did:example:test/place.wisp.fs/failure-site', cid: 'cid' } }
						},
						deleteRecord: async () => undefined,
					},
				},
			},
		}
		const files = validatePublicUploadFiles([new File(['hello'], 'index.bin')], MAX_SITE_SIZE)

		await processUploadInBackground(jobId, agent as never, did, 'failure-site', files, [])

		expect(putRecordCalls).toBe(0)
		expect(getUploadJob(jobId)).toMatchObject({ status: 'failed', error: UPLOAD_FAILED_MESSAGE })
		expect(JSON.stringify(logs)).not.toContain(SENTINEL)
		expect(getUploadJobStats().listeners).toBe(0)
	})

	test('fails closed before uploading blobs when the existing root cannot be read', async () => {
		logs.length = 0
		const did = `did:example:rootread${crypto.randomUUID().replaceAll('-', '')}`
		const jobId = createUploadJob(did, 'root-read-site', 1)
		let blobUploads = 0
		const agent = {
			com: {
				atproto: {
					repo: {
						getRecord: async () => {
							throw Object.assign(new Error(SENTINEL), { status: 500 })
						},
						uploadBlob: async () => {
							blobUploads++
							throw new Error('not reached')
						},
						putRecord: async () => {
							throw new Error('not reached')
						},
						deleteRecord: async () => undefined,
					},
				},
			},
		}
		const files = validatePublicUploadFiles([new File(['hello'], 'index.html')], MAX_SITE_SIZE)

		await processUploadInBackground(jobId, agent as never, did, 'root-read-site', files, [])
		expect(blobUploads).toBe(0)
		expect(getUploadJob(jobId)).toMatchObject({ status: 'failed', error: UPLOAD_FAILED_MESSAGE, errorStatus: 500 })
		expect(JSON.stringify(logs)).not.toContain(SENTINEL)
	})

	test('reports a root compare-and-swap conflict as a safe retryable 409 job failure', async () => {
		const did = `did:example:conflict${crypto.randomUUID().replaceAll('-', '')}`
		const jobId = createUploadJob(did, 'conflict-site', 1)
		let rootPuts = 0
		const agent = {
			com: {
				atproto: {
					repo: {
						getRecord: async () => ({
							data: {
								cid: 'stale-root-cid',
								value: { $type: 'place.wisp.fs', root: { type: 'directory', entries: [] } },
							},
						}),
						uploadBlob: async () => ({ data: { blob: { ref: { toString: () => 'blob-cid' } } } }),
						putRecord: async () => {
							rootPuts++
							throw Object.assign(new Error(SENTINEL), { status: 409, error: 'InvalidSwap' })
						},
						deleteRecord: async () => undefined,
					},
				},
			},
		}
		const files = validatePublicUploadFiles([new File(['hello'], 'index.html')], MAX_SITE_SIZE)

		await processUploadInBackground(jobId, agent as never, did, 'conflict-site', files, [])
		expect(rootPuts).toBe(1)
		expect(getUploadJob(jobId)).toMatchObject({ status: 'failed', error: UPLOAD_CONFLICT_MESSAGE, errorStatus: 409 })
	})

	test('aborts after an in-flight blob before a root manifest can commit', async () => {
		const did = `did:example:abort${crypto.randomUUID().replaceAll('-', '')}`
		const jobId = createUploadJob(did, 'abort-site', 1)
		const controller = new AbortController()
		let rootPuts = 0
		const agent = {
			com: {
				atproto: {
					repo: {
						getRecord: async () => {
							throw { error: 'RecordNotFound' }
						},
						uploadBlob: async () => {
							controller.abort()
							return { data: { blob: { ref: { toString: () => 'cid' } } } }
						},
						putRecord: async () => {
							rootPuts++
							return { data: { uri: `at://${did}/place.wisp.fs/abort-site`, cid: 'cid' } }
						},
						deleteRecord: async () => undefined,
					},
				},
			},
		}
		const files = validatePublicUploadFiles([new File(['hello'], 'index.html')], MAX_SITE_SIZE)

		await processUploadInBackground(jobId, agent as never, did, 'abort-site', files, [], controller.signal)
		expect(rootPuts).toBe(0)
		expect(getUploadJob(jobId)).toMatchObject({ status: 'failed', error: UPLOAD_FAILED_MESSAGE })
	})

	test('never fetches or deletes external or malformed old SubFS subjects with a matching rkey', async () => {
		const did = `did:example:owner${crypto.randomUUID().replaceAll('-', '')}`
		const root = {
			$type: 'place.wisp.fs#directory',
			type: 'directory',
			entries: [
				{
					name: 'external',
					node: {
						$type: 'place.wisp.fs#subfs',
						type: 'subfs',
						subject: 'at://did:example:someoneelse/place.wisp.subfs/same-rkey',
						flat: true,
					},
				},
				{
					name: 'malformed',
					node: {
						$type: 'place.wisp.fs#subfs',
						type: 'subfs',
						subject: `at://${did}/place.wisp.subfs/same-rkey?query`,
						flat: true,
					},
				},
			],
		} as never
		expect(collectOwnedSubfsSubjects(root, did)).toEqual([])

		const jobId = createUploadJob(did, 'subfs-site', 0)
		const getCalls: unknown[] = []
		const deleteCalls: unknown[] = []
		const agent = {
			com: {
				atproto: {
					repo: {
						getRecord: async (input: unknown) => {
							getCalls.push(input)
							return { data: { cid: 'existing-cid', value: { $type: 'place.wisp.fs', root } } }
						},
						uploadBlob: async () => {
							throw new Error('not reached')
						},
						putRecord: async () => ({ data: { uri: `at://${did}/place.wisp.fs/subfs-site`, cid: 'cid' } }),
						deleteRecord: async (input: unknown) => {
							deleteCalls.push(input)
						},
					},
				},
			},
		}

		await processUploadInBackground(jobId, agent as never, did, 'subfs-site', [], [])
		expect(getCalls).toHaveLength(1)
		expect(deleteCalls).toEqual([])
		expect(getUploadJob(jobId)?.status).toBe('completed')
	})
})
