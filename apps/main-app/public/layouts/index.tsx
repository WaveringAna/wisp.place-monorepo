import type { PropsWithChildren } from 'react'
import { useEffect } from 'react'

import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import clsx from 'clsx'

import '@public/styles/global.css'

const client = new QueryClient()

interface LayoutProps extends PropsWithChildren {
	className?: string
}

export default function Layout({ children, className }: LayoutProps) {
	useEffect(() => {
		// Function to update dark mode based on system preference
		const updateDarkMode = (e: MediaQueryList | MediaQueryListEvent) => {
			if (e.matches) {
				document.documentElement.classList.add('dark')
			} else {
				document.documentElement.classList.remove('dark')
			}
		}

		// Create media query
		const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)')

		// Set initial value
		updateDarkMode(darkModeQuery)

		// Listen for changes
		darkModeQuery.addEventListener('change', updateDarkMode)

		// Cleanup
		return () => darkModeQuery.removeEventListener('change', updateDarkMode)
	}, [])

	return (
		<QueryClientProvider client={client}>
			<div
				className={clsx(
					'flex flex-col items-center w-full min-h-screen',
					className
				)}
			>
				{children}
			</div>
		</QueryClientProvider>
	)
}
