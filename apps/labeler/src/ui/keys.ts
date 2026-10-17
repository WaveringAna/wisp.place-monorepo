import type { Verdict } from '../moderation/types'

export type KeyCommand =
	| { kind: 'move'; by: 1 | -1 }
	| { kind: 'open' }
	| { kind: 'preview' }
	| { kind: 'verdict'; verdict: Verdict }
	| { kind: 'account' }
	| { kind: 'search' }
	| { kind: 'undo' }
	| { kind: 'help' }
	| { kind: 'escape' }

export type KeyInput = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }

const PLAIN: Record<string, KeyCommand> = {
	j: { kind: 'move', by: 1 },
	k: { kind: 'move', by: -1 },
	o: { kind: 'open' },
	p: { kind: 'preview' },
	f: { kind: 'verdict', verdict: 'fine' },
	e: { kind: 'verdict', verdict: 'empty' },
	m: { kind: 'verdict', verdict: 'mass-created' },
	s: { kind: 'verdict', verdict: 'spam' },
	a: { kind: 'account' },
	'/': { kind: 'search' },
	u: { kind: 'undo' },
	'?': { kind: 'help' },
}

/**
 * The command for a key press, or null to let the browser have it. While typing in
 * a field only Escape is taken; modified keys (ctrl, cmd, alt) are never taken.
 */
export function commandForKey(input: KeyInput, typing: boolean): KeyCommand | null {
	if (input.key === 'Escape') return { kind: 'escape' }
	if (typing || input.ctrlKey || input.metaKey || input.altKey) return null
	return PLAIN[input.key] ?? null
}

export const SHORTCUTS: [string, string][] = [
	['j / k', 'next / previous'],
	['o', 'open site'],
	['p', 'preview'],
	['f e m s', 'fine, empty, mass-created, spam'],
	['a', 'open account'],
	['/', 'search'],
	['u', 'undo'],
	['?', 'shortcuts'],
]
