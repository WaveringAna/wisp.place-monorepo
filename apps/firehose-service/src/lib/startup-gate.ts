/** One-shot coordination between leader acquisition and startup-only work. */
export interface StartupGate {
	wait(): Promise<boolean>
	open(): void
	cancel(): void
}

/**
 * Resolve true after the protected worker starts, or false when startup is
 * cancelled. The first terminal signal wins so shutdown cannot be undone by a
 * late leader callback.
 */
export function createStartupGate(): StartupGate {
	let settled = false
	let resolve!: (opened: boolean) => void
	const result = new Promise<boolean>((done) => {
		resolve = done
	})

	const settle = (opened: boolean) => {
		if (settled) return
		settled = true
		resolve(opened)
	}

	return {
		wait: () => result,
		open: () => settle(true),
		cancel: () => settle(false),
	}
}
