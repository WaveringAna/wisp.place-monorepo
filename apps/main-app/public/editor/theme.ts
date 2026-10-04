import { useSyncExternalStore } from 'react'
import { createStore, useStore } from './store'

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'wisp-theme'
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

const storedTheme = (): Theme | null => {
	const value = document.documentElement.dataset.theme
	return value === 'light' || value === 'dark' ? value : null
}

// The inline script in the page head applies the saved choice before first paint.
const themeStore = createStore<Theme | null>(storedTheme())

const subscribeSystem = (listener: () => void) => {
	systemDark.addEventListener('change', listener)
	return () => systemDark.removeEventListener('change', listener)
}

/** Same toggle and storage key as the landing page, so the choice follows you across. */
export function useTheme() {
	const chosen = useStore(themeStore)
	const prefersDark = useSyncExternalStore(subscribeSystem, () => systemDark.matches)
	const isDark = chosen ? chosen === 'dark' : prefersDark

	const toggle = () => {
		const next: Theme = isDark ? 'light' : 'dark'
		document.documentElement.dataset.theme = next
		try {
			localStorage.setItem(STORAGE_KEY, next)
		} catch {
			// Private browsing can refuse storage; the toggle still applies to this page.
		}
		themeStore.set(next)
	}

	return { isDark, toggle }
}
