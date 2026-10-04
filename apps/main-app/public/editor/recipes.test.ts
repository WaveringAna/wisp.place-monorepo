import { describe, expect, test } from 'bun:test'
import { previewWorkflow } from './recipes'

const workflow = previewWorkflow({
	handle: 'okami.mom',
	claim: 'null',
	previewHost: 'preview.wisp.place',
	branch: 'main',
	build: 'pnpm install --frozen-lockfile\npnpm build',
	path: './dist',
})

describe('previewWorkflow', () => {
	test('is valid yaml that runs on pull requests into the branch', () => {
		const parsed = Bun.YAML.parse(workflow) as {
			when: { event: string[]; branch: string[] }[]
			environment: Record<string, string>
			steps: { name: string; command: string }[]
		}
		expect(parsed.when).toEqual([{ event: ['pull_request'], branch: ['main'] }])
		expect(parsed.environment).toEqual({
			WISP_HANDLE: 'okami.mom',
			PREVIEW_HOST: 'preview.wisp.place',
			PREVIEW_CLAIM: 'null',
		})
		expect(parsed.steps.map((step) => step.name)).toEqual(['build', 'deploy preview'])
		expect(parsed.steps[0]?.command).toBe('pnpm install --frozen-lockfile\npnpm build\n')
	})

	test('deploys the commit with the pinned cli and never calls the bot itself', () => {
		expect(workflow).toContain('wispctl@2.0.2')
		expect(workflow).toContain('--sha "$TANGLED_COMMIT_SHA"')
		expect(workflow).toContain('--path ./dist')
		expect(workflow).not.toContain('curl')
		expect(workflow).not.toContain('preview-bot')
	})

	test('leaves the build step out when there is nothing to build', () => {
		const parsed = Bun.YAML.parse(
			previewWorkflow({ handle: 'a.b', claim: 'a', previewHost: 'p.example', branch: 'main', build: '  ', path: '.' }),
		) as {
			steps: { name: string }[]
		}
		expect(parsed.steps.map((step) => step.name)).toEqual(['deploy preview'])
	})
})
