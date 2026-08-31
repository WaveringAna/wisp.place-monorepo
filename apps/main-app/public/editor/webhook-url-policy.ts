export const isLoopbackWebhookHost = (hostname: string): boolean => {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
	return (
		normalized === 'localhost' ||
		normalized.endsWith('.localhost') ||
		normalized === '127.0.0.1' ||
		normalized === '::1'
	)
}

export const canUseLocalLoopbackWebhookHttp = (pageUrl: string): boolean => {
	try {
		const page = new URL(pageUrl)
		return page.protocol === 'http:' && isLoopbackWebhookHost(page.hostname)
	} catch {
		return false
	}
}

/** Mirrors the API's HTTPS-first policy without exposing the input URL in errors. */
export const validateEditorWebhookEndpointUrl = (
	value: string,
	options: { readonly allowLoopbackDev: boolean },
): { readonly ok: true } | { readonly ok: false; readonly error: string } => {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return { ok: false, error: 'Enter a valid HTTPS webhook endpoint.' }
	}
	if (url.username || url.password || url.hash || !url.hostname) {
		return { ok: false, error: 'Enter a valid HTTPS webhook endpoint.' }
	}
	if (url.protocol === 'https:') return { ok: true }
	if (options.allowLoopbackDev && url.protocol === 'http:' && isLoopbackWebhookHost(url.hostname)) return { ok: true }
	return { ok: false, error: 'Webhook endpoints must use HTTPS. HTTP is allowed only for local loopback development.' }
}
