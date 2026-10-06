export const WISPCTL_VERSION = '2.1.0'

export interface PreviewWorkflowInput {
	/** Pull requests into this branch get previews. */
	branch: string
	/** Shell lines that build the site; empty when the repo is already static. */
	build: string
	/** Directory to deploy, relative to the repo root. */
	path: string
}

const indent = (text: string, spaces: number) =>
	text
		.split('\n')
		.map((line) => (line ? ' '.repeat(spaces) + line : line))
		.join('\n')

const quote = (value: string) => JSON.stringify(value)

/**
 * `.tangled/workflows/preview.yml` for one repo. It names no account, claim or host:
 * `wispctl preview deploy` reads those from the spindle and the repo's preview webhook,
 * and the webhook wakes the preview bot, which comments on the pull request.
 */
export function previewWorkflow(input: PreviewWorkflowInput): string {
	const build = input.build.trim()
	const buildStep = build ? `  - name: build\n    command: |\n${indent(build, 6)}\n\n` : ''
	return `when:
  - event: ["pull_request"]
    branch: [${quote(input.branch)}]

engine: microvm
image: nixos

dependencies:
  - nodejs

steps:
${buildStep}  - name: deploy preview
    command: |
      npm install --global --prefix "$HOME/.local" wispctl@${WISPCTL_VERSION}
      export PATH="$HOME/.local/bin:$PATH"
      wispctl preview deploy --path ${quote(input.path)}
`
}
