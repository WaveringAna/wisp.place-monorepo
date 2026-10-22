import { useEffect, useId, useRef, useState } from 'react'
import { Button } from './ui'

/** Set once the dialog has been dismissed, so it is shown a single time per browser. */
const SEEN_KEY = 'wisp-donate-seen'

// Brand marks from Simple Icons (CC0), inlined so the dashboard makes no third-party request.
const DONATE_LINKS = [
	{
		name: 'ko-fi',
		label: 'Ko-fi',
		href: 'https://ko-fi.com/waveringana',
		color: '#FF5E5B',
		path: 'M11.351 2.715c-2.7 0-4.986.025-6.83.26C2.078 3.285 0 5.154 0 8.61c0 3.506.182 6.13 1.585 8.493 1.584 2.701 4.233 4.182 7.662 4.182h.83c4.209 0 6.494-2.234 7.637-4a9.5 9.5 0 0 0 1.091-2.338C21.792 14.688 24 12.22 24 9.208v-.415c0-3.247-2.13-5.507-5.792-5.87-1.558-.156-2.65-.208-6.857-.208m0 1.947c4.208 0 5.09.052 6.571.182 2.624.311 4.13 1.584 4.13 4v.39c0 2.156-1.792 3.844-3.87 3.844h-.935l-.156.649c-.208 1.013-.597 1.818-1.039 2.546-.909 1.428-2.545 3.064-5.922 3.064h-.805c-2.571 0-4.831-.883-6.078-3.195-1.09-2-1.298-4.155-1.298-7.506 0-2.181.857-3.402 3.012-3.714 1.533-.233 3.559-.26 6.39-.26m6.547 2.287c-.416 0-.65.234-.65.546v2.935c0 .311.234.545.65.545 1.324 0 2.051-.754 2.051-2s-.727-2.026-2.052-2.026m-10.39.182c-1.818 0-3.013 1.48-3.013 3.142 0 1.533.858 2.857 1.949 3.897.727.701 1.87 1.429 2.649 1.896a1.47 1.47 0 0 0 1.507 0c.78-.467 1.922-1.195 2.623-1.896 1.117-1.039 1.974-2.364 1.974-3.897 0-1.662-1.247-3.142-3.039-3.142-1.065 0-1.792.545-2.338 1.298-.493-.753-1.246-1.298-2.312-1.298',
	},
	{
		name: 'github',
		label: 'GitHub Sponsors',
		href: 'https://github.com/sponsors/WaveringAna',
		color: '#EA4AAA',
		path: 'M17.625 1.499c-2.32 0-4.354 1.203-5.625 3.03-1.271-1.827-3.305-3.03-5.625-3.03C3.129 1.499 0 4.253 0 8.249c0 4.275 3.068 7.847 5.828 10.227a33.14 33.14 0 0 0 5.616 3.876l.028.017.008.003-.001.003c.163.085.342.126.521.125.179.001.358-.041.521-.125l-.001-.003.008-.003.028-.017a33.14 33.14 0 0 0 5.616-3.876C20.932 16.096 24 12.524 24 8.249c0-3.996-3.129-6.75-6.375-6.75zm-.919 15.275a30.766 30.766 0 0 1-4.703 3.316l-.004-.002-.004.002a30.955 30.955 0 0 1-4.703-3.316c-2.677-2.307-5.047-5.298-5.047-8.523 0-2.754 2.121-4.5 4.125-4.5 2.06 0 3.914 1.479 4.544 3.684.143.495.596.797 1.086.796.49.001.943-.302 1.085-.796.63-2.205 2.484-3.684 4.544-3.684 2.004 0 4.125 1.746 4.125 4.5 0 3.225-2.37 6.216-5.048 8.523z',
	},
	{
		name: 'liberapay',
		label: 'Liberapay',
		href: 'https://liberapay.com/nekomimi/',
		color: '#F6C915',
		path: 'M2.32 0A2.321 2.321 0 0 0 0 2.32v19.36A2.321 2.321 0 0 0 2.32 24h19.36A2.32 2.32 0 0 0 24 21.68V2.32A2.32 2.32 0 0 0 21.68 0zm9.208 3.98l-2.27 9.405a2.953 2.953 0 0 0-.073.539.853.853 0 0 0 .09.432.7.7 0 0 0 .334.302c.157.077.378.126.661.147l-.49 2.008c-.772 0-1.38-.1-1.82-.3-.441-.203-.757-.477-.947-.826a2.391 2.391 0 0 1-.278-1.2c.005-.452.068-.933.188-1.445l2.074-8.67zm3.9 3.888c.61 0 1.135.092 1.576.277.44.185.802.438 1.085.76.283.32.493.696.629 1.126.136.43.204.89.204 1.379v.001c0 .794-.13 1.52-.392 2.179a5.16 5.16 0 0 1-1.086 1.706 4.84 4.84 0 0 1-1.665 1.118c-.648.267-1.353.4-2.114.4-.37 0-.74-.033-1.11-.098l-.735 2.956H9.403l2.71-11.298c.435-.13.934-.248 1.494-.351a10.045 10.045 0 0 1 1.821-.155zm-.31 2.041a4.67 4.67 0 0 0-.98.098l-1.143 4.752c.185.044.413.065.685.065.425 0 .812-.079 1.16-.237a2.556 2.556 0 0 0 .89-.661c.244-.283.435-.623.571-1.02a4.03 4.03 0 0 0 .204-1.315c0-.468-.104-.865-.31-1.192-.207-.326-.566-.49-1.077-.49z',
	},
] as const

const seen = () => {
	try {
		return localStorage.getItem(SEEN_KEY) !== null
	} catch {
		// Without storage there is no way to remember the dismissal; better never than every visit.
		return true
	}
}

const markSeen = () => {
	try {
		localStorage.setItem(SEEN_KEY, new Date().toISOString())
	} catch {}
}

/** A one-time note asking for donations, shown the first time someone reaches the dashboard. */
export function DonateDialog({ ready }: { ready: boolean }) {
	const ref = useRef<HTMLDialogElement>(null)
	const titleId = useId()
	const [open, setOpen] = useState(false)

	useEffect(() => {
		if (ready && !seen()) setOpen(true)
	}, [ready])

	useEffect(() => {
		const dialog = ref.current
		if (!open || !dialog || dialog.open) return
		dialog.showModal()
		// The card itself takes focus, so no donation link or button starts out highlighted.
		dialog.focus()
	}, [open])

	const close = () => {
		markSeen()
		ref.current?.close()
		setOpen(false)
	}

	if (!open) return null

	return (
		<dialog
			ref={ref}
			className="dialog donate outline-none"
			tabIndex={-1}
			aria-labelledby={titleId}
			onCancel={(event) => {
				event.preventDefault()
				close()
			}}
		>
			<div className="donate-heart" aria-hidden="true">
				♥
			</div>
			<h2 id={titleId} className="donate-title">
				wisp is free, and made by one person
			</h2>
			<p className="text-ink-soft">
				hosting costs money, time and resources. if wisp is useful to you, a donation helps keep it running.
			</p>
			<div className="donate-links">
				{DONATE_LINKS.map((link) => (
					<a
						key={link.name}
						href={link.href}
						title={link.label}
						target="_blank"
						rel="noopener noreferrer"
						onClick={markSeen}
					>
						<span className="donate-mark" style={{ background: link.color }}>
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d={link.path} />
							</svg>
						</span>
						<span>{link.name}</span>
					</a>
				))}
			</div>
			<Button variant="ghost" className="w-full justify-center" onClick={close}>
				not now
			</Button>
		</dialog>
	)
}
