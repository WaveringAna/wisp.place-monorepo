import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const MAX_WEBHOOK_URL_LENGTH = 2048

function isPrivateIp(ip: string): boolean {
	const version = isIP(ip)
	if (version === 4) {
		const [a = 0, b = 0] = ip.split('.').map((part) => Number.parseInt(part, 10))
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			a >= 224
		)
	}

	if (version === 6) {
		const normalized = ip.toLowerCase()
		return (
			normalized === '::' ||
			normalized === '::1' ||
			normalized.startsWith('fc') ||
			normalized.startsWith('fd') ||
			normalized.startsWith('fe8') ||
			normalized.startsWith('fe9') ||
			normalized.startsWith('fea') ||
			normalized.startsWith('feb') ||
			normalized.startsWith('ff') ||
			normalized.startsWith('::ffff:127.') ||
			normalized.startsWith('::ffff:10.') ||
			normalized.startsWith('::ffff:169.254.') ||
			normalized.startsWith('::ffff:192.168.') ||
			/^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized)
		)
	}

	return true
}

function parseWebhookUrl(url: string): URL {
	if (url.length > MAX_WEBHOOK_URL_LENGTH) {
		throw new Error('Webhook URL is too long')
	}

	let parsed: URL
	try {
		parsed = new URL(url)
	} catch (_err) {
		throw new Error('Webhook URL is invalid')
	}

	if (parsed.protocol !== 'https:') {
		throw new Error('Webhook URL must use HTTPS')
	}

	if (parsed.username || parsed.password) {
		throw new Error('Webhook URL must not contain credentials')
	}

	return parsed
}

export async function assertSafeWebhookUrl(url: string): Promise<void> {
	const parsed = parseWebhookUrl(url)
	const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')

	if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
		throw new Error('Webhook URL host is not allowed')
	}

	if (isIP(hostname)) {
		if (isPrivateIp(hostname)) {
			throw new Error('Webhook URL resolves to a private address')
		}
		return
	}

	const addresses = await lookup(hostname, { all: true, verbatim: true })
	if (addresses.length === 0) {
		throw new Error('Webhook URL host did not resolve')
	}

	for (const { address } of addresses) {
		if (isPrivateIp(address)) {
			throw new Error('Webhook URL resolves to a private address')
		}
	}
}

export function assertSafeWebhookUrlSyntax(url: string): void {
	parseWebhookUrl(url)
}
