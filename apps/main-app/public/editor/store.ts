import { useSyncExternalStore } from 'react'

export interface Store<T> {
	get: () => T
	set: (next: T) => void
	subscribe: (listener: () => void) => () => void
}

export function createStore<T>(initial: T): Store<T> {
	let state = initial
	const listeners = new Set<() => void>()
	return {
		get: () => state,
		set: (next) => {
			state = next
			for (const listener of listeners) listener()
		},
		subscribe: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
}

export const useStore = <T>(store: Store<T>): T => useSyncExternalStore(store.subscribe, store.get)

export interface Notice {
	id: number
	tone: 'ok' | 'error'
	text: string
}

/** One status line at a time, like a terminal: the newest message replaces the last. */
export const noticeStore = createStore<Notice | null>(null)

let noticeTimer: ReturnType<typeof setTimeout> | undefined
let noticeId = 0

const show = (tone: Notice['tone'], text: string) => {
	clearTimeout(noticeTimer)
	const notice = { id: ++noticeId, tone, text }
	noticeStore.set(notice)
	noticeTimer = setTimeout(
		() => {
			if (noticeStore.get()?.id === notice.id) noticeStore.set(null)
		},
		tone === 'error' ? 9000 : 4000,
	)
}

export const notify = {
	ok: (text: string) => show('ok', text),
	error: (text: string) => show('error', text),
}
