import { type KeyboardEvent, useRef, useState } from 'react'

// Radios stay "typing": their arrow keys move the selection.
const TEXT_INPUT_EXEMPT = new Set(['checkbox', 'button', 'submit', 'reset'])

/** True when keystrokes belong to a field rather than to dashboard shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)
		return true
	return target instanceof HTMLInputElement && !TEXT_INPUT_EXEMPT.has(target.type)
}

export type RowKeyHandler = (index: number, key: string) => boolean

export type RowProps = ReturnType<ReturnType<typeof useRovingList>>

/** Maps single keys to actions on the focused row, e.g. `{ o: open, d: remove }`. */
export const rowActions =
	<T>(items: readonly T[], actions: Partial<Record<string, (item: T) => void>>): RowKeyHandler =>
	(index, key) => {
		const action = actions[key]
		const item = items[index]
		if (!action || item === undefined) return false
		action(item)
		return true
	}

/**
 * Roving focus for a list of rows: one row is in the tab order, j/k or the
 * arrow keys move between rows, and any other key is offered to `onKey`.
 */
export function useRovingList(count: number, onKey?: RowKeyHandler) {
	const [active, setActive] = useState(0)
	const rows = useRef<(HTMLElement | null)[]>([])
	const current = Math.min(active, Math.max(count - 1, 0))

	const focusRow = (index: number) => rows.current[Math.min(Math.max(index, 0), count - 1)]?.focus()

	const navigate = (key: string, index: number): boolean => {
		switch (key) {
			case 'ArrowDown':
			case 'j':
				focusRow(index + 1)
				return true
			case 'ArrowUp':
			case 'k':
				focusRow(index - 1)
				return true
			case 'Home':
				focusRow(0)
				return true
			case 'End':
				focusRow(count - 1)
				return true
			default:
				return false
		}
	}

	return (index: number) => ({
		ref: (element: HTMLElement | null) => {
			rows.current[index] = element
		},
		tabIndex: index === current ? 0 : -1,
		'data-row': '',
		onFocus: () => setActive(index),
		onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
			if (event.altKey || event.ctrlKey || event.metaKey) return
			if (navigate(event.key, index) || onKey?.(index, event.key)) event.preventDefault()
		},
	})
}
