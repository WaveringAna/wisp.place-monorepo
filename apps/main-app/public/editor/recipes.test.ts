import { describe, expect, test } from 'bun:test'
import { previewWorkflow, WISPCTL_VERSION } from './recipes'

const workflow = previewWorkflow({
	branch: 'main',
	build: 'pnpm install --frozen-lockfile\npnpm build',
	path: './dist',
})

describe('previewWorkflow', () => {
	test('is valid yaml that runs on pull requests into the branch', () => {
		const parsed = Bun.YAML.parse(workflow) as {
			when: { event: string[]; branch: string[] }[]
			environment?: unknown
			steps: { name: string; command: string }[]
		}
		expect(parsed.when).toEqual([{ event: ['pull_request'], branch: ['main'] }])
		expect(parsed.environment).toBeUndefined()
		expect(parsed.steps.map((step) => step.name)).toEqual(['build', 'deploy preview'])
		expect(parsed.steps[0]?.command).toBe('pnpm install --frozen-lockfile\npnpm build\n')
	})

	test('deploys with the pinned cli and names no account, claim or host', () => {
		expect(workflow).toContain(`wispctl@${WISPCTL_VERSION}`)
		expect(workflow).toContain('wispctl preview deploy --path "./dist"')
		for (const setting of ['PREVIEW_CLAIM', 'PREVIEW_HOST', 'WISP_HANDLE', '--sha', 'curl', 'preview-bot']) {
			expect(workflow).not.toContain(setting)
		}
	})

	test('leaves the build step out when there is nothing to build', () => {
		const parsed = Bun.YAML.parse(previewWorkflow({ branch: 'main', build: '  ', path: '.' })) as {
			steps: { name: string }[]
		}
		expect(parsed.steps.map((step) => step.name)).toEqual(['deploy preview'])
	})
})
