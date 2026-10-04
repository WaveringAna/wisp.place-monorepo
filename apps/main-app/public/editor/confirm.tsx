import type { KeyboardEvent, ReactNode } from 'react'
import { createStore, useStore } from './store'
import { Button, Dialog, Kbd } from './ui'

interface ConfirmRequest {
	title: string
	body: ReactNode
	action: string
	resolve: (confirmed: boolean) => void
}

const confirmStore = createStore<ConfirmRequest | null>(null)

/** Asks before something destructive; resolves false if the dialog is dismissed. */
export const confirmAction = (request: Omit<ConfirmRequest, 'resolve'>) =>
	new Promise<boolean>((resolve) => confirmStore.set({ ...request, resolve }))

export function ConfirmHost() {
	const request = useStore(confirmStore)

	const settle = (confirmed: boolean) => {
		request?.resolve(confirmed)
		confirmStore.set(null)
	}

	// Focus starts on cancel; y and n answer from either button, like a [y/N] prompt.
	const answerKey = (event: KeyboardEvent) => {
		if (event.key === 'y' || event.key === 'n') {
			event.preventDefault()
			settle(event.key === 'y')
		}
	}

	return (
		<Dialog
			open={request !== null}
			onClose={() => settle(false)}
			title={request?.title ?? ''}
			footer={
				<>
					<Button
						variant="ghost"
						className="ml-auto"
						onClick={() => settle(false)}
						onKeyDown={answerKey}
						data-autofocus
					>
						cancel <Kbd>n</Kbd>
					</Button>
					<Button variant="primary" onClick={() => settle(true)} onKeyDown={answerKey}>
						{request?.action} <Kbd>y</Kbd>
					</Button>
				</>
			}
		>
			<div className="text-ink-soft">{request?.body}</div>
		</Dialog>
	)
}
