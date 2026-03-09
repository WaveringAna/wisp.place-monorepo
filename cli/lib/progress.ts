import { spinner } from '@clack/prompts'
import pc from 'picocolors'

export { pc }

export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B'
	const k = 1024
	const sizes = ['B', 'KB', 'MB', 'GB']
	const i = Math.floor(Math.log(bytes) / Math.log(k))
	return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i] ?? 'TB'}`
}

// Adapter to provide ora-like interface using clack spinner
export interface SpinnerLike {
	text: string
	start(): SpinnerLike
	succeed(text?: string): SpinnerLike
	fail(text?: string): SpinnerLike
}

export function createSpinner(text: string): SpinnerLike {
	const s = spinner()
	let currentText = text
	let started = false

	return {
		get text() {
			return currentText
		},
		set text(newText: string) {
			currentText = newText
			if (started) {
				s.message(newText)
			}
		},
		start() {
			started = true
			s.start(currentText)
			return this
		},
		succeed(message?: string) {
			s.stop(pc.green('✓ ') + (message ?? currentText))
			started = false
			return this
		},
		fail(message?: string) {
			s.stop(pc.red('✗ ') + (message ?? currentText))
			started = false
			return this
		},
	}
}
