import { readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

const appRoot = resolve(import.meta.dir, '..')
const testRoots = ['public', 'src']

const findTestFiles = async (directory: string): Promise<string[]> => {
	const files: string[] = []
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await findTestFiles(path)))
		} else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
			files.push(relative(appRoot, path))
		}
	}
	return files
}

const asTestFile = (value: string): string => {
	const path = resolve(appRoot, value)
	const pathFromApp = relative(appRoot, path)
	if (
		pathFromApp === '..' ||
		pathFromApp.startsWith(`..${sep}`) ||
		pathFromApp.length === 0 ||
		!pathFromApp.endsWith('.test.ts')
	) {
		throw new Error(`Test path must be an app-local .test.ts file: ${value}`)
	}
	return pathFromApp
}

const requestedFiles = process.argv.slice(2)
const testFiles = (
	requestedFiles.length > 0
		? requestedFiles.map(asTestFile)
		: (await Promise.all(testRoots.map((root) => findTestFiles(resolve(appRoot, root))))).flat()
).sort()

if (testFiles.length === 0) {
	throw new Error('No main-app test files found')
}

// Bun's mock.module registry is process-global. Run each file in a fresh Bun
// process so a route test's replacement of a shared module cannot alter a later
// file. Do not forward either production endpoint into a test child. db.test
// reads only TEST_DATABASE_URL, which db.ts validates as a local disposable DB.
const testEnvironment: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'test' }
delete testEnvironment.DATABASE_URL
delete testEnvironment.DATABASE_READ_URL

const failedFiles: string[] = []
for (const testFile of testFiles) {
	console.log(`\n[test-isolated] ${testFile}`)
	const child = Bun.spawn([process.execPath, 'test', testFile], {
		cwd: appRoot,
		env: testEnvironment,
		stderr: 'inherit',
		stdout: 'inherit',
	})
	if ((await child.exited) !== 0) failedFiles.push(testFile)
}

if (failedFiles.length > 0) {
	console.error(`\n[test-isolated] failed: ${failedFiles.join(', ')}`)
	process.exitCode = 1
}
