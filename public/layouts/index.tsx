import type { PropsWithChildren } from 'react'

import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import clsx from 'clsx'

import '@public/styles/global.css'

const client = new QueryClient()

interface LayoutProps extends PropsWithChildren {
	className?: string
}

export default function Layout({ children, className }: LayoutProps) {
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
