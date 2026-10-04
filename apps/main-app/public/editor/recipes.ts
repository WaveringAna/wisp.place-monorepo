export const WISPCTL_VERSION = '2.0.2'

export interface PreviewWorkflowInput {
	handle: string
	claim: string
	previewHost: string
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
 * `.tangled/workflows/preview.yml` for one repo. It only deploys: the webhook
 * the dashboard creates wakes the preview bot, which comments on the pull request.
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

environment:
  WISP_HANDLE: ${quote(input.handle)}
  PREVIEW_HOST: ${quote(input.previewHost)}
  PREVIEW_CLAIM: ${quote(input.claim)}

steps:
${buildStep}  - name: deploy preview
    command: |
      set -euo pipefail
      if [ -z "\${WISP_APP_PASSWORD:-}" ]; then
        echo "no deploy secret here (a pull request from a fork); skipping"
        exit 0
      fi
      npm install --global --prefix "$HOME/.local" wispctl@${WISPCTL_VERSION}
      export PATH="$HOME/.local/bin:$PATH"
      wispctl deploy "$WISP_HANDLE" \\
        --password "$WISP_APP_PASSWORD" \\
        --path ${input.path} \\
        --sha "$TANGLED_COMMIT_SHA" \\
        --header "X-Robots-Tag: noindex" \\
        --preview-host "$PREVIEW_HOST" \\
        --preview-claim "$PREVIEW_CLAIM" \\
        --yes
`
}
