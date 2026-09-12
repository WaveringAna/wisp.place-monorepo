import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function importStorage(cache: string, operation: string): Promise<void> {
	const child = Bun.spawn(
		[
			process.execPath,
			'-e',
			`import { getStorage, getStorageStatsSnapshot } from ${JSON.stringify(join(import.meta.dir, 'storage.ts'))}; ${operation}`,
		],
		{
			cwd: join(import.meta.dir, '../..'),
			env: {
				...process.env,
				NODE_ENV: 'test',
				S3_BUCKET: '',
				S3_ENDPOINT: '',
				AWS_ACCESS_KEY_ID: '',
				AWS_SECRET_ACCESS_KEY: '',
				FIREHOSE_ALLOW_DISK_STORAGE: 'true',
				CACHE_DIR: cache,
			},
			stdout: 'pipe',
			stderr: 'pipe',
		},
	)
	const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
	expect(stderr).toBe('')
	expect(exit).toBe(0)
}

test('read-only imports and health snapshots leave invalidated cache files untouched', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'wisp-storage-readonly-'))
	try {
		const retired = join(directory, '.invalidated', 'recoverable')
		await mkdir(retired, { recursive: true })
		await writeFile(join(retired, 'index.html'), 'recoverable')
		await importStorage(directory, 'getStorageStatsSnapshot()')
		expect(await readFile(join(retired, 'index.html'), 'utf8')).toBe('recoverable')
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('explicit storage operations initialize once and retain read/write behavior', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'wisp-storage-lazy-'))
	try {
		await importStorage(
			directory,
			`
			const storage = getStorage();
			if (getStorage() !== storage) throw new Error('Storage not memoized');
			await storage.set('site/index.html', new TextEncoder().encode('valid'), { onlyTiers: ['cold'] });
			const value = await storage.get('site/index.html');
			if (!value || new TextDecoder().decode(value) !== 'valid') throw new Error('Storage round-trip failed');
		`,
		)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
